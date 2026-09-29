//! Windows-only, picker-scoped, flat-directory operations. IPC never accepts paths.
//! Keep ancestor directory handles open without FILE_SHARE_DELETE, reject reparse
//! points/hard links, and hash/delete through one locked handle. Only explicit
//! MD/TXT editing carries bounded (256 KiB) UTF-8 content over IPC.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs::{File, OpenOptions}, io::{Read, Write, Seek, SeekFrom}, path::{Path, PathBuf}, sync::{Arc, Mutex}, time::UNIX_EPOCH};
use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
use windows_sys::Win32::{Foundation::GENERIC_READ, Storage::FileSystem::*};

const MAX_FILE: u64 = 64 * 1024 * 1024;
const MAX_TEXT: usize = 256 * 1024;
const IO_ERROR: &str = "文件不可访问、被占用或权限不足。请检查所选目录。";
fn io_error(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound { "NotFoundError".into() } else { IO_ERROR.into() }
}
fn info(file: &File) -> Result<BY_HANDLE_FILE_INFORMATION, String> {
    let mut data = std::mem::MaybeUninit::uninit();
    // SAFETY: live owned file handle and a properly-sized writable output buffer.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), data.as_mut_ptr()) } == 0 { return Err(IO_ERROR.into()); }
    Ok(unsafe { data.assume_init() })
}
fn identity(file: &File) -> Result<String, String> {
    let data = info(file)?;
    Ok(format!("{:x}", Sha256::digest(format!("{}:{}:{}:{}:{}", data.dwVolumeSerialNumber, data.nFileIndexHigh, data.nFileIndexLow, data.ftCreationTime.dwHighDateTime, data.ftCreationTime.dwLowDateTime))))
}
fn validate_name(name: &str) -> Result<(), String> {
    let base = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    if name.is_empty() || name.encode_utf16().count() > 240 || name.ends_with(['.', ' '])
        || name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || ["con", "prn", "aux", "nul", "conin$", "conout$"].contains(&base.as_str())
        || ["com", "lpt"].iter().any(|prefix| base.strip_prefix(prefix).is_some_and(|n| ["1","2","3","4","5","6","7","8","9","¹","²","³"].contains(&n)))
    { return Err("无效文件名。".into()); }
    Ok(())
}
struct Grant { path: PathBuf, _locks: Vec<File>, descriptor: Directory }
#[derive(Clone, Serialize)]
pub struct Directory { token: String, name: String, identity: String }
#[derive(Default)]
struct Registry { session: String, grants: HashMap<String, Grant> }
#[derive(Default)]
pub struct Directories(Arc<Mutex<Registry>>);

fn grant(path: &Path) -> Result<Grant, String> {
    if !path.is_absolute() { return Err("请选择本机绝对目录。".into()); }
    let mut locks = Vec::new();
    let mut ancestors: Vec<_> = path.ancestors().collect(); ancestors.reverse();
    for ancestor in ancestors {
        // Attribute-only handles do NOT participate in Windows sharing checks.
        // FILE_LIST_DIRECTORY is essential to prevent rename/replacement.
        let file = OpenOptions::new().access_mode(FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY).share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).open(ancestor).map_err(io_error)?;
        let data = info(&file)?;
        if data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
            return Err("不支持符号链接、目录联接或云端占位目录，请选择普通本机目录。".into());
        }
        locks.push(file);
    }
    let descriptor = Directory { token: uuid::Uuid::new_v4().to_string(), name: path.file_name().and_then(|v| v.to_str()).unwrap_or("所选目录").into(), identity: identity(locks.last().ok_or(IO_ERROR)?)? };
    Ok(Grant { path: path.into(), _locks: locks, descriptor })
}
#[tauri::command]
pub async fn organizer_pick_directory(session: String, state: tauri::State<'_, Directories>) -> Result<Option<Directory>, String> {
    if uuid::Uuid::parse_str(&session).is_err() { return Err("无效目录会话。".into()); }
    let selected = rfd::AsyncFileDialog::new().set_title("选择 GeiIt 文件整理目录").pick_folder().await;
    let Some(selected) = selected else { return Ok(None); };
    let registry = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let new = grant(selected.path())?;
        let mut registry = registry.lock().map_err(|_| IO_ERROR)?;
        if registry.session != session { registry.grants.clear(); registry.session = session; }
        if registry.grants.len() >= 8 { return Err("目录授权过多，请先关闭文件整理页面。".into()); }
        let descriptor = new.descriptor.clone();
        registry.grants.insert(descriptor.token.clone(), new); Ok(Some(descriptor))
    }).await.map_err(|_| IO_ERROR)?
}
#[tauri::command]
pub fn organizer_release_directory(token: String, state: tauri::State<'_, Directories>) {
    if let Ok(mut registry) = state.0.lock() { registry.grants.remove(&token); }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    List { token: String },
    Stat { token: String, name: String, identity: Option<String> },
    Create { token: String, name: String },
    Hash { token: String, name: String, identity: String },
    Copy { token: String, name: String, identity: String, source_token: String, source_name: String, source_identity: String },
    Remove { token: String, name: String, identity: String, sha256: String },
    ReadText { token: String, name: String, identity: String },
    WriteText { token: String, name: String, identity: String, sha256: String, text: String },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileInfo { size: u64, modified_at: u64, identity: String }
fn file_info(file: &File) -> Result<FileInfo, String> {
    let metadata = file.metadata().map_err(io_error)?;
    Ok(FileInfo { size: metadata.len(), modified_at: metadata.modified().map_err(io_error)?.duration_since(UNIX_EPOCH).map_err(|_| IO_ERROR)?.as_millis() as u64, identity: identity(file)? })
}
fn open(registry: &Registry, token: &str, name: &str, expected: Option<&str>, create: bool, delete: bool, write: bool) -> Result<File, String> {
    validate_name(name)?;
    let directory = registry.grants.get(token).ok_or("目录授权已失效，请重新选择。")?;
    let mut options = OpenOptions::new();
    options.read(true).write(write || create).create_new(create).share_mode(FILE_SHARE_READ).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    if delete { options.access_mode(GENERIC_READ | DELETE); }
    let file = options.open(directory.path.join(name)).map_err(io_error)?;
    let data = info(&file)?;
    if data.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0 || data.nNumberOfLinks != 1 {
        return Err("仅支持普通文件，不支持符号链接、硬链接或云端占位文件。".into());
    }
    if expected.is_some_and(|value| identity(&file).as_deref() != Ok(value)) { return Err("文件已被替换，已停止操作并保留副本。".into()); }
    Ok(file)
}
fn hash(file: &mut File) -> Result<String, String> {
    if file.metadata().map_err(io_error)?.len() > MAX_FILE { return Err("单个文件最多 64 MiB。".into()); }
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    let mut digest = Sha256::new(); let mut buffer = [0u8; 65536]; let mut total = 0;
    loop {
        let n = file.read(&mut buffer).map_err(io_error)?; if n == 0 { break; }
        total += n as u64; if total > MAX_FILE { return Err("单个文件最多 64 MiB。".into()); }
        digest.update(&buffer[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn text_name(name: &str) -> Result<(), String> {
    validate_name(name)?;
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if ext != "md" && ext != "txt" { return Err("仅支持 MD/TXT 文本编辑。".into()); }
    Ok(())
}
fn validate_text(bytes: &[u8]) -> Result<&str, String> {
    if bytes.len() > MAX_TEXT { return Err("文本编辑单文件最多 256 KiB。".into()); }
    let text = std::str::from_utf8(bytes).map_err(|_| "文件不是有效 UTF-8。")?;
    if text.chars().any(|c| (c <= '\u{1f}' && !['\t', '\r', '\n'].contains(&c)) || c == '\u{7f}') { return Err("文件含有二进制控制字符。".into()); }
    Ok(text)
}
fn read_text(file: &mut File) -> Result<String, String> {
    if file.metadata().map_err(io_error)?.len() > MAX_TEXT as u64 { return Err("文本编辑单文件最多 256 KiB。".into()); }
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    let mut bytes = Vec::new(); file.take(MAX_TEXT as u64 + 1).read_to_end(&mut bytes).map_err(io_error)?;
    Ok(validate_text(&bytes)?.to_owned())
}
fn put_bytes(file: &mut File, bytes: &[u8]) -> std::io::Result<()> {
    file.seek(SeekFrom::Start(0))?; file.write_all(bytes)?; file.set_len(bytes.len() as u64)?; file.sync_all()
}
// In-place guarded write, not atomic replacement or a power-loss guarantee.
// Keep the same locked handle for write, verification and best-effort rollback.
fn write_with_rollback(file: &mut File, before: &[u8], after: &[u8], writer: impl FnOnce(&mut File, &[u8]) -> std::io::Result<()>) -> Result<(), String> {
    let expected = format!("{:x}", Sha256::digest(after));
    if writer(file, after).is_ok() && hash(file).as_deref() == Ok(expected.as_str()) { return Ok(()); }
    let original = format!("{:x}", Sha256::digest(before));
    if put_bytes(file, before).is_ok() && hash(file).as_deref() == Ok(original.as_str()) {
        Err("写入失败，已校验恢复原文。请核验记录后重试。".into())
    } else { Err("写入与原文恢复未能完成，请保留文件并从加密历史导出原文进行人工恢复。".into()) }
}
fn execute(registry: &Registry, operation: Operation) -> Result<serde_json::Value, String> {
    use Operation::*;
    let tokens = match &operation {
        List { token } | Stat { token, .. } | Create { token, .. } | Hash { token, .. } | Remove { token, .. } | ReadText { token, .. } | WriteText { token, .. } => vec![token],
        Copy { token, source_token, .. } => vec![token, source_token],
    };
    // Temporarily exclude directory-data writes while resolving child paths.
    // Permanent no-delete handles above prevent rename; these additional locks
    // reject in-place reparse changes without blocking file renames between IPCs.
    let mut scope_locks = Vec::new();
    for token in tokens { scope_locks.extend(lock_scope(registry.grants.get(token).ok_or("目录授权已失效，请重新选择。")?)?); }
    match operation {
        List { token } => {
            let directory = registry.grants.get(&token).ok_or("目录授权已失效，请重新选择。")?;
            let mut entries = Vec::new();
            for entry in std::fs::read_dir(&directory.path).map_err(io_error)? {
                if entries.len() >= 5000 { return Err("目录条目超过 5000，请先拆分目录。".into()); }
                let entry = entry.map_err(io_error)?;
                let name = entry.file_name().into_string().map_err(|_| "不支持此文件名编码。")?;
                let kind = if entry.file_type().map_err(io_error)?.is_dir() { "directory" } else { "file" };
                entries.push(serde_json::json!({ "name": name, "kind": kind }));
            }
            Ok(serde_json::json!(entries))
        }
        Stat { token, name, identity } => Ok(serde_json::json!(file_info(&open(registry, &token, &name, identity.as_deref(), false, false, false)?)?)),
        Create { token, name } => Ok(serde_json::json!(file_info(&open(registry, &token, &name, None, true, false, false)?)?)),
        Hash { token, name, identity } => Ok(serde_json::json!(hash(&mut open(registry, &token, &name, Some(&identity), false, false, false)?)?)),
        ReadText { token, name, identity } => {
            text_name(&name)?;
            let mut file = open(registry, &token, &name, Some(&identity), false, false, false)?;
            let text = read_text(&mut file)?;
            Ok(serde_json::json!({ "sha256": format!("{:x}", Sha256::digest(text.as_bytes())), "text": text, "identity": identity }))
        }
        WriteText { token, name, identity, sha256, text } => {
            text_name(&name)?; validate_text(text.as_bytes())?;
            let mut file = open(registry, &token, &name, Some(&identity), false, false, true)?;
            let before = read_text(&mut file)?;
            if format!("{:x}", Sha256::digest(before.as_bytes())) != sha256 { return Err("文件已在外部修改，已停止写入。".into()); }
            write_with_rollback(&mut file, before.as_bytes(), text.as_bytes(), put_bytes)?;
            Ok(serde_json::Value::Null)
        }
        Copy { token, name, identity, source_token, source_name, source_identity } => {
            let mut source = open(registry, &source_token, &source_name, Some(&source_identity), false, false, false)?;
            if source.metadata().map_err(io_error)?.len() > MAX_FILE { return Err("单个文件最多 64 MiB。".into()); }
            let mut target = open(registry, &token, &name, Some(&identity), false, false, true)?;
            if target.metadata().map_err(io_error)?.len() != 0 { return Err("目标文件不是空文件，已保留现场。".into()); }
            std::io::copy(&mut source, &mut target).map_err(io_error)?; target.sync_all().map_err(io_error)?;
            Ok(serde_json::Value::Null)
        }
        Remove { token, name, identity, sha256 } => {
            let mut file = open(registry, &token, &name, Some(&identity), false, true, false)?;
            if hash(&mut file)? != sha256 { return Err("文件内容已改变，已停止删除并保留副本。".into()); }
            let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
            // SAFETY: delete-capable handle is live and denies concurrent writes/deletes;
            // the disposition struct and its size match FileDispositionInfo.
            if unsafe { SetFileInformationByHandle(file.as_raw_handle(), FileDispositionInfo, &disposition as *const _ as _, std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32) } == 0 { return Err(IO_ERROR.into()); }
            Ok(serde_json::Value::Null)
        }
    }
}
fn lock_scope(directory: &Grant) -> Result<Vec<File>, String> {
    let mut paths: Vec<_> = directory.path.ancestors().collect(); paths.reverse();
    let mut locks = Vec::new();
    for (path, original) in paths.into_iter().zip(&directory._locks) {
        let locked = OpenOptions::new().access_mode(FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY).share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).open(path).map_err(io_error)?;
        if info(&locked)?.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || identity(&locked)? != identity(original)? {
            return Err("目录已被替换或成为链接，请重新选择普通目录。".into());
        }
        locks.push(locked);
    }
    Ok(locks)
}
#[tauri::command]
pub async fn organizer_access(operation: Operation, state: tauri::State<'_, Directories>) -> Result<serde_json::Value, String> {
    let registry = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let registry = registry.lock().map_err(|_| IO_ERROR)?;
        execute(&registry, operation)
    }).await.map_err(|_| IO_ERROR)?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Registry, String, String) {
        let root = tempfile::tempdir().unwrap();
        let mut registry = Registry::default();
        let mut tokens = Vec::new();
        for name in ["source", "target"] {
            let path = root.path().join(name); std::fs::create_dir(&path).unwrap();
            let directory = grant(&path).unwrap(); tokens.push(directory.descriptor.token.clone());
            registry.grants.insert(directory.descriptor.token.clone(), directory);
        }
        (root, registry, tokens[0].clone(), tokens[1].clone())
    }
    fn stat(registry: &Registry, token: &str, name: &str) -> FileInfo {
        file_info(&open(registry, token, name, None, false, false, false).unwrap()).unwrap()
    }
    #[test]
    fn native_copy_hash_delete_and_reselect_identity() {
        let (root, registry, source, target) = fixture();
        std::fs::write(root.path().join("source/a.txt"), "synthetic A 中文").unwrap();
        let src = stat(&registry, &source, "a.txt");
        let sha = hash(&mut open(&registry, &source, "a.txt", Some(&src.identity), false, false, false).unwrap()).unwrap();
        let dst = execute(&registry, Operation::Create { token: target.clone(), name: "a.txt".into() }).unwrap();
        execute(&registry, Operation::Copy { token: target.clone(), name: "a.txt".into(), identity: dst["identity"].as_str().unwrap().into(), source_token: source.clone(), source_name: "a.txt".into(), source_identity: src.identity.clone() }).unwrap();
        assert_eq!(std::fs::read(root.path().join("source/a.txt")).unwrap(), std::fs::read(root.path().join("target/a.txt")).unwrap());
        execute(&registry, Operation::Remove { token: source.clone(), name: "a.txt".into(), identity: src.identity, sha256: sha }).unwrap();
        assert!(!root.path().join("source/a.txt").exists());
        let reselected = grant(&root.path().join("source")).unwrap();
        assert_eq!(reselected.descriptor.identity, registry.grants[&source].descriptor.identity);
        assert_ne!(reselected.descriptor.token, source);
    }
    #[test]
    fn rejects_ungranted_paths_unsafe_names_and_overwrite() {
        let (root, registry, source, _) = fixture();
        std::fs::write(root.path().join("source/a.txt"), "original").unwrap();
        for name in ["../escape", "a/b", "a\\b", "C:\\secret", "a:stream", "NUL", "con.txt", "COM¹", "CONOUT$", "trailing.", "trailing "] {
            assert!(open(&registry, &source, name, None, true, false, false).is_err(), "{name}");
        }
        assert!(open(&registry, "guessed-token", "a.txt", None, false, false, false).is_err());
        assert!(open(&registry, &source, "A.TXT", None, true, false, false).is_err());
        assert_eq!(std::fs::read_to_string(root.path().join("source/a.txt")).unwrap(), "original");
        assert!(serde_json::from_value::<Operation>(serde_json::json!({ "op": "list", "token": source, "path": root.path() })).is_err());
    }
    #[test]
    fn guarded_delete_refuses_external_edits_and_replacements() {
        let (root, registry, source, _) = fixture();
        let path = root.path().join("source/a.txt"); std::fs::write(&path, "A").unwrap();
        let src = stat(&registry, &source, "a.txt");
        let sha = hash(&mut open(&registry, &source, "a.txt", None, false, false, false).unwrap()).unwrap();
        std::fs::write(&path, "B").unwrap();
        assert!(execute(&registry, Operation::Remove { token: source.clone(), name: "a.txt".into(), identity: src.identity.clone(), sha256: sha.clone() }).is_err());
        std::fs::rename(&path, root.path().join("source/old.txt")).unwrap(); std::fs::write(&path, "A").unwrap();
        assert!(execute(&registry, Operation::Remove { token: source, name: "a.txt".into(), identity: src.identity, sha256: sha }).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "A");
    }
    #[test]
    fn rejects_hardlinks_and_locks_ancestors_and_open_files() {
        let (root, registry, source, _) = fixture();
        let path = root.path().join("source/a.txt"); std::fs::write(&path, "A").unwrap();
        {
            let _held = open(&registry, &source, "a.txt", None, false, false, false).unwrap();
            assert!(std::fs::write(&path, "changed").is_err()); assert!(std::fs::remove_file(&path).is_err());
        }
        assert!(std::fs::rename(root.path().join("source"), root.path().join("replaced")).is_err());
        {
            let _scope = lock_scope(&registry.grants[&source]).unwrap();
            assert!(OpenOptions::new().access_mode(FILE_WRITE_DATA).share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS).open(root.path().join("source")).is_err());
        }
        std::fs::hard_link(&path, root.path().join("target/link.txt")).unwrap();
        assert!(open(&registry, &source, "a.txt", None, false, false, false).is_err());
    }
    #[test]
    fn copy_refuses_nonempty_targets_and_large_sources() {
        let (root, registry, source, target) = fixture();
        let a = root.path().join("source/a.txt"); std::fs::write(&a, "A").unwrap();
        let b = root.path().join("target/b.txt"); std::fs::write(&b, "B").unwrap();
        let copy = || Operation::Copy { token: target.clone(), name: "b.txt".into(), identity: stat(&registry, &target, "b.txt").identity, source_token: source.clone(), source_name: "a.txt".into(), source_identity: stat(&registry, &source, "a.txt").identity };
        assert!(execute(&registry, copy()).is_err());
        std::fs::write(&b, "").unwrap(); File::options().write(true).open(&a).unwrap().set_len(MAX_FILE + 1).unwrap();
        assert!(execute(&registry, copy()).is_err()); assert_eq!(std::fs::metadata(&b).unwrap().len(), 0);
    }
    #[test]
    fn text_write_preserves_bom_unicode_newlines_and_truncates_on_locked_handle() {
        let (root, registry, token, _) = fixture(); let path = root.path().join("source/a.md");
        let original = "\u{feff}# 合成🙂\r\nlong original\r\n";
        std::fs::write(&path, original).unwrap(); let id = stat(&registry, &token, "a.md").identity;
        let read = execute(&registry, Operation::ReadText { token: token.clone(), name: "a.md".into(), identity: id.clone() }).unwrap();
        assert_eq!(read["text"], original);
        let after = "\u{feff}短\r\n";
        execute(&registry, Operation::WriteText { token: token.clone(), name: "a.md".into(), identity: id.clone(), sha256: read["sha256"].as_str().unwrap().into(), text: after.into() }).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), after.as_bytes());
        assert_eq!(stat(&registry, &token, "a.md").identity, id);
        let new_sha = format!("{:x}", Sha256::digest(after.as_bytes()));
        execute(&registry, Operation::WriteText { token, name: "a.md".into(), identity: id, sha256: new_sha, text: String::new() }).unwrap();
        assert!(std::fs::read(path).unwrap().is_empty());
    }
    #[test]
    fn text_write_refuses_stale_hash_identity_nontext_and_oversize_without_changes() {
        let (root, registry, token, _) = fixture(); let path = root.path().join("source/a.txt");
        std::fs::write(&path, "old").unwrap(); let id = stat(&registry, &token, "a.txt").identity;
        let sha = format!("{:x}", Sha256::digest(b"old"));
        let write = |text: String| Operation::WriteText { token: token.clone(), name: "a.txt".into(), identity: id.clone(), sha256: sha.clone(), text };
        for text in ["x\0y".into(), "x".repeat(MAX_TEXT + 1)] { assert!(execute(&registry, write(text)).is_err()); }
        std::fs::write(&path, "external").unwrap(); assert!(execute(&registry, write("new".into())).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "external");
        std::fs::rename(&path, root.path().join("source/old.txt")).unwrap(); std::fs::write(&path, "old").unwrap();
        assert!(execute(&registry, write("new".into())).is_err()); assert_eq!(std::fs::read_to_string(&path).unwrap(), "old");
        for bytes in [vec![0xff], vec![0], vec![b'x'; MAX_TEXT + 1]] {
            std::fs::write(&path, bytes).unwrap();
            assert!(execute(&registry, Operation::ReadText { token: token.clone(), name: "a.txt".into(), identity: stat(&registry, &token, "a.txt").identity }).is_err());
        }
        assert!(text_name("a.json").is_err()); assert!(text_name("../a.md").is_err());
        assert!(serde_json::from_value::<Operation>(serde_json::json!({ "op": "write_text", "token": token, "name": "a.txt", "identity": id, "sha256": sha, "text": "new", "path": "C:\\ignored" })).is_err());
    }
    #[test]
    fn failed_partial_text_write_restores_exact_bytes_and_reports_rollback_failure() {
        let (root, registry, token, _) = fixture(); let path = root.path().join("source/a.txt");
        let original = "\u{feff}原文\r\n".as_bytes(); std::fs::write(&path, original).unwrap();
        let mut file = open(&registry, &token, "a.txt", None, false, false, true).unwrap();
        let error = write_with_rollback(&mut file, original, b"changed", |file, _| {
            file.seek(SeekFrom::Start(0))?; file.write_all(b"partial write that extends the file")?;
            Err(std::io::Error::other("synthetic disk fault"))
        }).unwrap_err();
        assert!(error.contains("已校验恢复原文")); drop(file);
        assert_eq!(std::fs::read(&path).unwrap(), original);
        let mut readonly = open(&registry, &token, "a.txt", None, false, false, false).unwrap();
        assert!(write_with_rollback(&mut readonly, original, b"changed", put_bytes).unwrap_err().contains("人工恢复"));
    }
}
