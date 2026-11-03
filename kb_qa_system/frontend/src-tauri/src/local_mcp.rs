//! Desktop-only managed packages. stdio is a trusted local process, not a sandbox.
//! No shell commands, remote launch definitions, inherited secrets or auto-start.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{oneshot, Semaphore},
};
use uuid::Uuid;
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
};

const FRAME_LIMIT: usize = 1024 * 1024;
const MAX_TOOLS: usize = 100;
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalConfig {
    pub connection_id: String,
    pub installation_id: String,
    pub entry_point: String,
    pub args: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Package {
    pub id: String,
    pub ecosystem: String,
    pub name: String,
    pub version: String,
    pub entry_points: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    name: String,
    description: String,
    input_schema: Value,
}
struct Grant {
    session_id: String,
    config: LocalConfig,
    env: BTreeMap<String, String>,
    tools: Vec<Tool>,
    approved: Vec<String>,
    rpc: Arc<tokio::sync::Mutex<Rpc>>,
}
struct PendingRequest {
    session_id: Option<String>,
    cancel: oneshot::Sender<()>,
}
#[derive(Default)]
struct Registry {
    grants: HashMap<String, Grant>,
    requests: HashMap<String, PendingRequest>,
}
pub struct McpState {
    registry: Mutex<Registry>,
    install: Semaphore,
    calls: Semaphore,
}
impl Default for McpState {
    fn default() -> Self {
        Self {
            registry: Mutex::default(),
            install: Semaphore::new(1),
            calls: Semaphore::new(2),
        }
    }
}
impl McpState {
    pub fn lock(&self) {
        if let Ok(mut registry) = self.registry.lock() {
            registry.grants.clear();
            for (_, request) in registry.requests.drain() {
                let _ = request.cancel.send(());
            }
        }
    }
    fn register(&self, id: &str, session_id: Option<&str>) -> Result<oneshot::Receiver<()>> {
        valid_id(id)?;
        let mut registry = self.registry.lock().map_err(|_| "MCP_STATE")?;
        if registry.requests.len() >= 4 || registry.requests.contains_key(id) {
            return Err("MCP_BUSY".into());
        }
        let (cancel, rx) = oneshot::channel();
        registry.requests.insert(
            id.into(),
            PendingRequest {
                session_id: session_id.map(str::to_owned),
                cancel,
            },
        );
        Ok(rx)
    }
    fn finish(&self, id: &str) {
        if let Ok(mut registry) = self.registry.lock() {
            registry.requests.remove(id);
        }
    }
}
fn valid_id(value: &str) -> Result<()> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| "MCP_CONFIG".into())
}
fn grant_key(session_id: &str, connection_id: &str) -> Result<String> {
    valid_id(session_id)?;
    valid_id(connection_id)?;
    Ok(format!("{session_id}:{connection_id}"))
}
fn safe_entry(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_- .".contains(&c))
        && !value.contains(' ')
        && !value.starts_with('.')
}
fn validate_package(ecosystem: &str, name: &str, version: &str) -> Result<()> {
    let valid_name = match ecosystem {
        "npm" => {
            let parts: Vec<_> = name.split('/').collect();
            let safe = |v: &str| {
                !v.is_empty()
                    && v.as_bytes()[0].is_ascii_alphanumeric()
                    && v.bytes().all(|b| {
                        b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_.".contains(&b)
                    })
            };
            parts.len() == 1 && safe(name)
                || parts.len() == 2
                    && parts[0].starts_with('@')
                    && safe(&parts[0][1..])
                    && safe(parts[1])
        }
        "python" => {
            !name.is_empty()
                && name.as_bytes()[0].is_ascii_alphanumeric()
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        }
        _ => false,
    };
    if !valid_name
        || name.len() > 160
        || version.is_empty()
        || version.len() > 60
        || !version.as_bytes()[0].is_ascii_digit()
        || !version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-+".contains(&b))
    {
        return Err("MCP_PACKAGE_SPEC".into());
    }
    if ecosystem == "npm"
        && !version.split(['-', '+']).next().is_some_and(|v| {
            v.split('.').count() == 3
                && v.split('.')
                    .all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()))
        })
    {
        return Err("MCP_PACKAGE_SPEC".into());
    }
    Ok(())
}
fn validate_registry(ecosystem: &str, registry: &str) -> Result<&'static str> {
    match (ecosystem, registry) {
        ("npm", "https://registry.npmjs.org") => Ok("https://registry.npmjs.org"),
        ("python", "https://pypi.org/simple") => Ok("https://pypi.org/simple"),
        ("python", "https://mirrors.aliyun.com/pypi/simple") => {
            Ok("https://mirrors.aliyun.com/pypi/simple")
        }
        _ => Err("MCP_REGISTRY".into()),
    }
}
fn validate_config(config: &LocalConfig, env: &BTreeMap<String, String>) -> Result<()> {
    valid_id(&config.connection_id)?;
    valid_id(&config.installation_id)?;
    if !safe_entry(&config.entry_point)
        || config.args.len() > 30
        || config
            .args
            .iter()
            .any(|arg| arg.len() > 2048 || arg.contains('\0'))
        || env.len() > 30
    {
        return Err("MCP_CONFIG".into());
    }
    for (key, value) in env {
        let upper = key.to_ascii_uppercase();
        if key.is_empty()
            || key.len() > 80
            || !key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
            || key.as_bytes()[0].is_ascii_digit()
            || value.len() > 4096
            || value.contains('\0')
            || [
                "PATH",
                "PATHEXT",
                "SYSTEMROOT",
                "WINDIR",
                "COMSPEC",
                "HOME",
                "USERPROFILE",
                "APPDATA",
                "LOCALAPPDATA",
                "TEMP",
                "TMP",
                "PYTHONHOME",
                "PYTHONPATH",
                "PYTHONSTARTUP",
                "NODE_OPTIONS",
                "NODE_PATH",
                "ELECTRON_RUN_AS_NODE",
            ]
            .contains(&upper.as_str())
            || upper.starts_with("NPM_")
            || upper.starts_with("PIP_")
        {
            return Err("MCP_ENV".into());
        }
    }
    Ok(())
}
fn validate_arguments(arguments: &Value, schema: &Value) -> Result<()> {
    let values = arguments.as_object().ok_or("MCP_CONFIG")?;
    if schema["type"] != "object" {
        return Err("MCP_SCHEMA".into());
    }
    if let Some(required) = schema["required"].as_array() {
        if required.len() > 100
            || required
                .iter()
                .any(|key| key.as_str().is_none_or(|key| !values.contains_key(key)))
        {
            return Err("MCP_CONFIG".into());
        }
    }
    if let Some(properties) = schema["properties"].as_object() {
        if properties.len() > 100 {
            return Err("MCP_SCHEMA".into());
        }
        for (key, value) in values {
            let Some(definition) = properties.get(key) else {
                if schema["additionalProperties"] == false {
                    return Err("MCP_CONFIG".into());
                }
                continue;
            };
            let matches_type = |kind: &str| match kind {
                "string" => value.is_string(),
                "number" => value.is_number(),
                "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
                "boolean" => value.is_boolean(),
                "object" => value.is_object(),
                "array" => value.is_array(),
                "null" => value.is_null(),
                _ => false,
            };
            let valid = match &definition["type"] {
                Value::String(kind) => matches_type(kind),
                Value::Array(types) if !types.is_empty() => types
                    .iter()
                    .any(|kind| kind.as_str().is_some_and(matches_type)),
                Value::Null => true,
                _ => false,
            };
            if !valid {
                return Err("MCP_CONFIG".into());
            }
        }
    }
    Ok(())
}
fn root(app: &tauri::AppHandle) -> Result<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map(|p| p.join("mcp-packages"))
        .map_err(|_| "MCP_STORAGE".into())
}
fn package_dir(root: &Path, id: &str) -> Result<PathBuf> {
    valid_id(id)?;
    Ok(root.join(id))
}
fn contained(root: &Path, path: &Path) -> Result<PathBuf> {
    // Node's CLI loader rejects ordinary drive paths with the verbatim \\?\
    // prefix returned by std::fs::canonicalize. dunce preserves canonical
    // containment while using normal Win32 paths whenever that is safe.
    let parent = dunce::canonicalize(root).map_err(|_| "MCP_STORAGE")?;
    let target = dunce::canonicalize(path).map_err(|_| "MCP_STORAGE")?;
    if target == parent || !target.starts_with(parent) {
        return Err("MCP_STORAGE".into());
    }
    Ok(target)
}
fn read_package(root: &Path, id: &str) -> Result<Package> {
    let dir = contained(root, &package_dir(root, id)?)?;
    let manifest = contained(&dir, &dir.join("manifest.json"))?;
    let bytes = std::fs::read(manifest).map_err(|_| "MCP_STORAGE")?;
    if bytes.len() > 16384 {
        return Err("MCP_STORAGE".into());
    }
    let package: Package = serde_json::from_slice(&bytes).map_err(|_| "MCP_STORAGE")?;
    validate_package(&package.ecosystem, &package.name, &package.version)?;
    if package.id != id
        || package.entry_points.is_empty()
        || package.entry_points.len() > 30
        || package.entry_points.iter().any(|v| !safe_entry(v))
    {
        return Err("MCP_STORAGE".into());
    }
    Ok(package)
}
fn executable(names: &[&str]) -> Result<PathBuf> {
    for name in names {
        for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
            if !dir.is_absolute()
                || dir
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .contains("windowsapps")
            {
                continue;
            }
            let path = dir.join(name);
            if path.is_file() {
                return dunce::canonicalize(path).map_err(|_| "MCP_RUNTIME".into());
            }
        }
    }
    Err("MCP_RUNTIME".into())
}
fn command(exe: &Path, dir: &Path) -> Command {
    let mut c = Command::new(exe);
    c.current_dir(dir)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .creation_flags(0x08000000);
    for key in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(key) {
            c.env(key, value);
        }
    }
    let system = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\Windows"));
    c.env(
        "PATH",
        std::env::join_paths([
            exe.parent().unwrap_or(dir).to_owned(),
            system.join("System32"),
        ])
        .unwrap_or_default(),
    );
    c.env("HOME", dir)
        .env("USERPROFILE", dir)
        .env("APPDATA", dir.join("config"))
        .env("LOCALAPPDATA", dir.join("cache"));
    c
}
struct Process {
    child: Child,
    job: HANDLE,
}
unsafe impl Send for Process {}
impl Process {
    fn spawn(command: &mut Command) -> Result<Self> {
        let mut child = command.spawn().map_err(|_| "MCP_START")?;
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            let _ = child.start_kill();
            return Err("MCP_START".into());
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let assigned = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            ) != 0
                && child
                    .raw_handle()
                    .is_some_and(|handle| AssignProcessToJobObject(job, handle as HANDLE) != 0)
        };
        if !assigned {
            unsafe {
                CloseHandle(job);
            }
            let _ = child.start_kill();
            return Err("MCP_START".into());
        }
        Ok(Self { child, job })
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.job);
        }
        let _ = self.child.start_kill();
    }
}
async fn run(mut cmd: Command) -> Result<Vec<u8>> {
    let mut process = Process::spawn(&mut cmd)?;
    process.child.stdin.take();
    let stdout = process.child.stdout.take().ok_or("MCP_START")?;
    let stderr = process.child.stderr.take().ok_or("MCP_START")?;
    let read = |stream| async move {
        let mut bytes = Vec::new();
        let mut limited = tokio::io::AsyncReadExt::take(stream, (FRAME_LIMIT + 1) as u64);
        limited
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "MCP_PROCESS")?;
        if bytes.len() > FRAME_LIMIT {
            return Err("MCP_LIMIT".to_string());
        }
        Ok(bytes)
    };
    let (out, err) = tokio::try_join!(
        read(Box::pin(stdout) as std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>>),
        read(Box::pin(stderr) as std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>>)
    )?;
    if !process
        .child
        .wait()
        .await
        .map_err(|_| "MCP_PROCESS")?
        .success()
    {
        return Err("MCP_INSTALL".into());
    }
    drop(err);
    Ok(out)
}
struct InstallDir(Option<PathBuf>);
impl Drop for InstallDir {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            for _ in 0..20 {
                if !path.exists() || std::fs::remove_dir_all(&path).is_ok() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}
async fn install(
    root: &Path,
    ecosystem: String,
    name: String,
    version: String,
    registry: String,
) -> Result<Package> {
    validate_package(&ecosystem, &name, &version)?;
    let registry = validate_registry(&ecosystem, &registry)?;
    std::fs::create_dir_all(root).map_err(|_| "MCP_STORAGE")?;
    if std::fs::read_dir(root).map_err(|_| "MCP_STORAGE")?.count() >= 30 {
        return Err("MCP_LIMIT".into());
    }
    let id = Uuid::new_v4().to_string();
    let staging_path = root.join(&id);
    let mut staging = InstallDir(Some(staging_path.clone()));
    std::fs::create_dir(&staging_path).map_err(|_| "MCP_STORAGE")?;
    let entries;
    if ecosystem == "npm" {
        let node = executable(&["node.exe"])?;
        let cli = node
            .parent()
            .ok_or("MCP_RUNTIME")?
            .join("node_modules/npm/bin/npm-cli.js");
        if !cli.is_file() {
            return Err("MCP_RUNTIME".into());
        }
        let mut cmd = command(&node, &staging_path);
        cmd.arg(cli)
            .args([
                "install",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                "--registry=https://registry.npmjs.org",
                "--cache",
            ])
            .arg(staging_path.join("cache"))
            .arg("--")
            .arg(format!("{name}@{version}"));
        run(cmd).await?;
        let package_root = contained(
            &staging_path,
            &staging_path.join("node_modules").join(&name),
        )?;
        let value: Value = serde_json::from_slice(
            &std::fs::read(package_root.join("package.json")).map_err(|_| "MCP_INSTALL")?,
        )
        .map_err(|_| "MCP_INSTALL")?;
        if value["name"] != name || value["version"] != version {
            return Err("MCP_INSTALL".into());
        }
        entries = match &value["bin"] {
            Value::Object(map) => map.keys().cloned().collect::<Vec<_>>(),
            Value::String(_) => vec![name.rsplit('/').next().unwrap_or(&name).to_string()],
            _ => vec![],
        };
    } else {
        let python = executable(&["python.exe", "python3.exe"])?;
        let mut cmd = command(&python, &staging_path);
        cmd.args(["-I", "-m", "venv", "--copies"])
            .arg(staging_path.join("venv"));
        run(cmd).await?;
        let python = staging_path.join("venv/Scripts/python.exe");
        let mut cmd = command(&python, &staging_path);
        cmd.args([
            "-I",
            "-m",
            "pip",
            "--isolated",
            "--disable-pip-version-check",
            "install",
            "--only-binary=:all:",
            "--no-input",
            "--index-url",
            registry,
            "--cache-dir",
        ])
        .arg(staging_path.join("cache"))
        .arg(format!("{name}=={version}"));
        run(cmd).await?;
        let mut cmd = command(&python, &staging_path);
        cmd.args(["-I", "-c", "import importlib.metadata,json,sys; d=importlib.metadata.distribution(sys.argv[1]); print(json.dumps([e.name for e in d.entry_points if e.group=='console_scripts']))", &name]);
        entries =
            serde_json::from_slice::<Vec<String>>(&run(cmd).await?).map_err(|_| "MCP_INSTALL")?;
    }
    if entries.is_empty() || entries.len() > 30 || entries.iter().any(|entry| !safe_entry(entry)) {
        return Err("MCP_ENTRY".into());
    }
    std::fs::remove_dir_all(staging_path.join("cache")).map_err(|_| "MCP_STORAGE")?;
    let package = Package {
        id: id.clone(),
        ecosystem,
        name,
        version,
        entry_points: entries,
    };
    std::fs::write(
        staging_path.join("manifest.json"),
        serde_json::to_vec(&package).map_err(|_| "MCP_INSTALL")?,
    )
    .map_err(|_| "MCP_STORAGE")?;
    staging.0 = None;
    Ok(package)
}
fn server_command(
    root: &Path,
    config: &LocalConfig,
    env: &BTreeMap<String, String>,
) -> Result<Command> {
    validate_config(config, env)?;
    let package = read_package(root, &config.installation_id)?;
    if !package.entry_points.contains(&config.entry_point) {
        return Err("MCP_ENTRY".into());
    }
    let dir = contained(root, &package_dir(root, &package.id)?)?;
    let mut cmd;
    if package.ecosystem == "npm" {
        let node = executable(&["node.exe"])?;
        let package_root = contained(&dir, &dir.join("node_modules").join(&package.name))?;
        let value: Value = serde_json::from_slice(
            &std::fs::read(package_root.join("package.json")).map_err(|_| "MCP_STORAGE")?,
        )
        .map_err(|_| "MCP_STORAGE")?;
        let bin = if value["bin"].is_string() {
            value["bin"].as_str()
        } else {
            value["bin"][&config.entry_point].as_str()
        }
        .ok_or("MCP_ENTRY")?;
        let entry = contained(&package_root, &package_root.join(bin))?;
        cmd = command(&node, &dir);
        cmd.arg(entry);
    } else {
        let python = contained(&dir, &dir.join("venv/Scripts/python.exe"))?;
        cmd = command(&python, &dir);
        cmd.args(["-I", "-u", "-c", "import importlib.metadata,sys; name,entry=sys.argv[1:3]; sys.argv=[entry]+sys.argv[3:]; next(e for e in importlib.metadata.distribution(name).entry_points if e.group=='console_scripts' and e.name==entry).load()()", &package.name, &config.entry_point]);
    }
    cmd.args(&config.args).envs(env);
    Ok(cmd)
}
struct Rpc {
    _process: Process,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr: tokio::task::JoinHandle<()>,
}
impl Drop for Rpc {
    fn drop(&mut self) {
        self.stderr.abort();
    }
}
impl Rpc {
    fn spawn(mut cmd: Command) -> Result<Self> {
        let mut process = Process::spawn(&mut cmd)?;
        let stdin = process.child.stdin.take().ok_or("MCP_START")?;
        let stdout = BufReader::new(process.child.stdout.take().ok_or("MCP_START")?);
        let mut stderr = process.child.stderr.take().ok_or("MCP_START")?;
        let drain = tokio::spawn(async move {
            let mut budget = FRAME_LIMIT;
            let mut buffer = [0u8; 4096];
            while let Ok(count) = stderr.read(&mut buffer).await {
                if count == 0 || count > budget {
                    break;
                }
                budget -= count;
            }
        });
        Ok(Self {
            _process: process,
            stdin,
            stdout,
            stderr: drain,
        })
    }
    async fn send(&mut self, value: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&value).map_err(|_| "MCP_PROTOCOL")?;
        if bytes.len() > FRAME_LIMIT {
            return Err("MCP_LIMIT".into());
        }
        bytes.push(b'\n');
        self.stdin
            .write_all(&bytes)
            .await
            .map_err(|_| "MCP_PROCESS")?;
        self.stdin.flush().await.map_err(|_| "MCP_PROCESS".into())
    }
    async fn response(&mut self, id: u64) -> Result<Value> {
        for _ in 0..64 {
            let mut line = Vec::new();
            loop {
                let bytes = self.stdout.fill_buf().await.map_err(|_| "MCP_PROCESS")?;
                if bytes.is_empty() {
                    return Err("MCP_PROCESS".into());
                }
                let count = bytes
                    .iter()
                    .position(|b| *b == b'\n')
                    .map(|n| n + 1)
                    .unwrap_or(bytes.len());
                if line.len() + count > FRAME_LIMIT {
                    return Err("MCP_LIMIT".into());
                }
                let complete = bytes[count - 1] == b'\n';
                line.extend_from_slice(&bytes[..count]);
                self.stdout.consume(count);
                if complete {
                    break;
                }
            }
            let message: Value = serde_json::from_slice(&line).map_err(|_| "MCP_PROTOCOL")?;
            if message["jsonrpc"] != "2.0" {
                return Err("MCP_PROTOCOL".into());
            }
            if message.get("method").is_some() {
                if message.get("id").is_some() {
                    self.send(json!({"jsonrpc":"2.0","id":message["id"],"error":{"code":-32601,"message":"Client capability not supported"}})).await?;
                }
                continue;
            }
            if message["id"] != id {
                return Err("MCP_PROTOCOL".into());
            }
            if message.get("error").is_some() {
                return Err("MCP_TOOL".into());
            }
            return message
                .get("result")
                .cloned()
                .ok_or_else(|| "MCP_PROTOCOL".into());
        }
        Err("MCP_LIMIT".into())
    }
    async fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value> {
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        self.response(id).await
    }
    async fn initialize(&mut self) -> Result<()> {
        let result = self.request(1, "initialize", json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"GeiIt Agents","version":"0.1.0"}})).await?;
        if !["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]
            .contains(&result["protocolVersion"].as_str().unwrap_or_default())
            || !result["capabilities"]["tools"].is_object()
        {
            return Err("MCP_PROTOCOL".into());
        }
        self.send(json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .await
    }
    async fn tools(&mut self) -> Result<Vec<Tool>> {
        let mut tools = Vec::new();
        let mut params = json!({});
        for page in 0..5 {
            let result = self.request(2 + page, "tools/list", params).await?;
            for item in result["tools"].as_array().ok_or("MCP_PROTOCOL")? {
                let name = item["name"].as_str().ok_or("MCP_PROTOCOL")?;
                if name.is_empty()
                    || name.len() > 80
                    || !name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
                    || !item["inputSchema"].is_object()
                    || tools.iter().any(|t: &Tool| t.name == name)
                    || tools.len() >= MAX_TOOLS
                {
                    return Err("MCP_LIMIT".into());
                }
                tools.push(Tool {
                    name: name.into(),
                    description: item["description"]
                        .as_str()
                        .unwrap_or_default()
                        .chars()
                        .take(1000)
                        .collect(),
                    input_schema: item["inputSchema"].clone(),
                });
            }
            match result.get("nextCursor").filter(|v| !v.is_null()) {
                Some(Value::String(cursor)) if cursor.len() <= 2048 && !cursor.is_empty() => {
                    params = json!({"cursor":cursor})
                }
                None => return Ok(tools),
                _ => return Err("MCP_PROTOCOL".into()),
            }
        }
        Err("MCP_LIMIT".into())
    }
}

#[tauri::command]
pub async fn mcp_packages(
    app: tauri::AppHandle,
    state: State<'_, Arc<McpState>>,
) -> Result<Vec<Package>> {
    let _permit = state.install.try_acquire().map_err(|_| "MCP_BUSY")?;
    let root = root(&app)?;
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut packages = Vec::new();
    for entry in std::fs::read_dir(&root)
        .map_err(|_| "MCP_STORAGE")?
        .take(100)
    {
        let entry = entry.map_err(|_| "MCP_STORAGE")?;
        let id = entry.file_name().to_string_lossy().to_string();
        if valid_id(&id).is_ok() && entry.file_type().map_err(|_| "MCP_STORAGE")?.is_dir() {
            if !entry.path().join("manifest.json").is_file() {
                let orphan = contained(&root, &package_dir(&root, &id)?)?;
                std::fs::remove_dir_all(orphan).map_err(|_| "MCP_STORAGE")?;
                continue;
            }
            packages.push(read_package(&root, &id)?);
        }
    }
    Ok(packages)
}
#[tauri::command]
pub async fn mcp_install(
    app: tauri::AppHandle,
    state: State<'_, Arc<McpState>>,
    request_id: String,
    ecosystem: String,
    name: String,
    version: String,
    registry: String,
) -> Result<Package> {
    let _permit = state.install.try_acquire().map_err(|_| "MCP_BUSY")?;
    let root = root(&app)?;
    let cancelled = state.register(&request_id, None)?;
    let result = tokio::select! { biased; _ = cancelled => Err("MCP_CANCELLED".into()), result = tokio::time::timeout(Duration::from_secs(600), install(&root, ecosystem, name, version, registry)) => result.unwrap_or_else(|_| Err("MCP_TIMEOUT".into())) };
    state.finish(&request_id);
    result
}
#[tauri::command]
pub async fn mcp_remove(
    app: tauri::AppHandle,
    state: State<'_, Arc<McpState>>,
    installation_id: String,
) -> Result<()> {
    let _permit = state.install.try_acquire().map_err(|_| "MCP_BUSY")?;
    let _calls = state.calls.try_acquire_many(2).map_err(|_| "MCP_BUSY")?;
    let root = root(&app)?;
    read_package(&root, &installation_id)?;
    state
        .registry
        .lock()
        .map_err(|_| "MCP_STATE")?
        .grants
        .retain(|_, g| g.config.installation_id != installation_id);
    let dir = contained(&root, &package_dir(&root, &installation_id)?)?;
    for _ in 0..20 {
        if !dir.exists() || std::fs::remove_dir_all(&dir).is_ok() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("MCP_STORAGE".into())
}
#[tauri::command]
pub fn mcp_disconnect(state: State<'_, Arc<McpState>>, session_id: String) -> Result<()> {
    valid_id(&session_id)?;
    let mut registry = state.registry.lock().map_err(|_| "MCP_STATE")?;
    registry
        .grants
        .retain(|_, grant| grant.session_id != session_id);
    let ids: Vec<_> = registry
        .requests
        .iter()
        .filter(|(_, request)| request.session_id.as_deref() == Some(&session_id))
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        if let Some(request) = registry.requests.remove(&id) {
            let _ = request.cancel.send(());
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn mcp_discover(
    app: tauri::AppHandle,
    state: State<'_, Arc<McpState>>,
    session_id: String,
    request_id: String,
    config: LocalConfig,
    env: BTreeMap<String, String>,
) -> Result<Vec<Tool>> {
    let _permit = state.calls.try_acquire().map_err(|_| "MCP_BUSY")?;
    validate_config(&config, &env)?;
    let key = grant_key(&session_id, &config.connection_id)?;
    let cancelled = state.register(&request_id, Some(&session_id))?;
    state
        .registry
        .lock()
        .map_err(|_| "MCP_STATE")?
        .grants
        .remove(&key);
    let operation = async {
        let mut rpc = Rpc::spawn(server_command(&root(&app)?, &config, &env)?)?;
        rpc.initialize().await?;
        let tools = rpc.tools().await?;
        Ok((Arc::new(tokio::sync::Mutex::new(rpc)), tools))
    };
    let mut result = tokio::select! { biased; _ = cancelled => Err("MCP_CANCELLED".into()), result = tokio::time::timeout(Duration::from_secs(25), operation) => result.unwrap_or_else(|_| Err("MCP_TIMEOUT".into())) };
    {
        let mut registry = state.registry.lock().map_err(|_| "MCP_STATE")?;
        if !registry.requests.contains_key(&request_id) {
            result = Err("MCP_CANCELLED".into());
        }
        if let Ok((rpc, tools)) = result.as_ref() {
            registry.grants.insert(
                key,
                Grant {
                    session_id,
                    config,
                    env,
                    tools: tools.clone(),
                    approved: vec![],
                    rpc: rpc.clone(),
                },
            );
        }
    }
    state.finish(&request_id);
    result.map(|(_, tools)| tools)
}
#[tauri::command]
pub fn mcp_approve(
    state: State<'_, Arc<McpState>>,
    session_id: String,
    config: LocalConfig,
    tools: Vec<String>,
) -> Result<()> {
    let mut registry = state.registry.lock().map_err(|_| "MCP_STATE")?;
    let grant = registry
        .grants
        .get_mut(&grant_key(&session_id, &config.connection_id)?)
        .ok_or("MCP_NOT_CONNECTED")?;
    if grant.config != config
        || tools.is_empty()
        || tools.len() > MAX_TOOLS
        || tools
            .iter()
            .any(|name| !grant.tools.iter().any(|tool| &tool.name == name))
    {
        return Err("MCP_CONFIG".into());
    }
    grant.approved = tools;
    Ok(())
}
fn check_status(
    state: &McpState,
    session_id: &str,
    config: &LocalConfig,
    tool: &str,
    env: &BTreeMap<String, String>,
) -> Result<()> {
    let registry = state.registry.lock().map_err(|_| "MCP_STATE")?;
    let grant = registry
        .grants
        .get(&grant_key(session_id, &config.connection_id)?)
        .ok_or("MCP_NOT_CONNECTED")?;
    if &grant.config != config
        || &grant.env != env
        || !grant.approved.iter().any(|item| item == tool)
    {
        return Err("MCP_NOT_APPROVED".into());
    }
    Ok(())
}
#[tauri::command]
pub fn mcp_status(
    state: State<'_, Arc<McpState>>,
    session_id: String,
    config: LocalConfig,
    tool: String,
    env: BTreeMap<String, String>,
) -> Result<()> {
    check_status(&state, &session_id, &config, &tool, &env)
}
#[tauri::command]
pub async fn mcp_call(
    state: State<'_, Arc<McpState>>,
    session_id: String,
    request_id: String,
    config: LocalConfig,
    tool: String,
    arguments: Value,
    env: BTreeMap<String, String>,
) -> Result<Value> {
    let _permit = state.calls.try_acquire().map_err(|_| "MCP_BUSY")?;
    let key = grant_key(&session_id, &config.connection_id)?;
    let (rpc, schema) = {
        let registry = state.registry.lock().map_err(|_| "MCP_STATE")?;
        let grant = registry.grants.get(&key).ok_or("MCP_NOT_CONNECTED")?;
        if grant.config != config || grant.env != env || !grant.approved.contains(&tool) {
            return Err("MCP_NOT_APPROVED".into());
        }
        (
            grant.rpc.clone(),
            grant
                .tools
                .iter()
                .find(|item| item.name == tool)
                .map(|item| item.input_schema.clone())
                .ok_or("MCP_NOT_APPROVED")?,
        )
    };
    if serde_json::to_vec(&arguments)
        .map_err(|_| "MCP_CONFIG")?
        .len()
        > 50000
    {
        return Err("MCP_CONFIG".into());
    }
    validate_arguments(&arguments, &schema)?;
    let cancelled = state.register(&request_id, Some(&session_id))?;
    let operation = async {
        check_status(&state, &session_id, &config, &tool, &env)?;
        let mut connection = rpc.lock().await;
        let result = connection
            .request(9, "tools/call", json!({"name":tool,"arguments":arguments}))
            .await?;
        if result["isError"] == true {
            return Err("MCP_TOOL".into());
        }
        let payload = if let Some(value) = result.get("structuredContent").filter(|v| v.is_object())
        {
            value.clone()
        } else {
            let blocks = result["content"].as_array().ok_or("MCP_PROTOCOL")?;
            if blocks.is_empty() || blocks.len() > 32 {
                return Err("MCP_PROTOCOL".into());
            }
            let text = blocks
                .iter()
                .filter_map(|block| block["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            if !text.is_empty() {
                match serde_json::from_str::<Value>(&text) {
                    Ok(value) => value,
                    _ => json!({"result":text}),
                }
            } else {
                json!({"content":blocks})
            }
        };
        if serde_json::to_vec(&payload)
            .map_err(|_| "MCP_PROTOCOL")?
            .len()
            > 100000
        {
            return Err("MCP_LIMIT".into());
        }
        Ok(payload)
    };
    let result = tokio::select! { biased; _ = cancelled => Err("MCP_CANCELLED".into()), result = tokio::time::timeout(Duration::from_secs(30), operation) => result.unwrap_or_else(|_| Err("MCP_TIMEOUT".into())) };
    state.finish(&request_id);
    if result.is_ok() {
        check_status(&state, &session_id, &config, &tool, &env)?;
    } else if let Ok(mut registry) = state.registry.lock() {
        registry.grants.remove(&key);
    }
    result
}
#[tauri::command]
pub fn mcp_cancel(state: State<'_, Arc<McpState>>, request_id: String) {
    if let Ok(mut registry) = state.registry.lock() {
        if let Some(request) = registry.requests.remove(&request_id) {
            let _ = request.cancel.send(());
        }
    }
}
#[tauri::command]
pub fn mcp_lock(state: State<'_, Arc<McpState>>) {
    state.lock();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn package_specs_never_become_options_paths_or_urls() {
        for (kind, name, version) in [
            (
                "npm",
                "@modelcontextprotocol/server-filesystem",
                "2025.8.21",
            ),
            ("python", "mcp-server-time", "2026.10.28"),
        ] {
            assert!(validate_package(kind, name, version).is_ok());
        }
        for (kind, name, version) in [
            ("npm", "--evil", "1.2.3"),
            ("npm", "file:abc", "1.2.3"),
            ("npm", "a/../../x", "1.2.3"),
            ("python", "https://x", "1"),
            ("python", "x", "1 --index-url=x"),
            ("npm", "x", "latest"),
            ("npm", "x", "^1.2.3"),
        ] {
            assert!(validate_package(kind, name, version).is_err());
        }
    }
    #[test]
    fn package_registries_are_fixed_permitted_https_sources() {
        assert!(validate_registry("npm", "https://registry.npmjs.org").is_ok());
        assert!(validate_registry("python", "https://pypi.org/simple").is_ok());
        assert!(validate_registry("python", "https://mirrors.aliyun.com/pypi/simple").is_ok());
        for registry in [
            "http://pypi.org/simple",
            "https://evil.example/simple",
            "https://pypi.org/simple?x=y",
        ] {
            assert!(validate_registry("python", registry).is_err());
        }
        assert!(validate_registry("npm", "https://mirrors.aliyun.com/pypi/simple").is_err());
    }
    #[test]
    fn argument_values_follow_discovered_json_schema() {
        let schema = json!({"type":"object","properties":{"limit":{"type":"integer"},"query":{"type":"string"}},"required":["query"],"additionalProperties":false});
        assert!(validate_arguments(&json!({"query":"x","limit":2}), &schema).is_ok());
        assert!(validate_arguments(&json!({"query":3}), &schema).is_err());
        assert!(validate_arguments(&json!({"query":"x","other":true}), &schema).is_err());
        assert!(validate_arguments(&json!({}), &schema).is_err());
    }
    #[test]
    fn config_rejects_runtime_injection_and_unmanaged_entries() {
        let config = LocalConfig {
            connection_id: Uuid::new_v4().to_string(),
            installation_id: Uuid::new_v4().to_string(),
            entry_point: "mcp-server-time".into(),
            args: vec![],
        };
        assert!(validate_config(&config, &BTreeMap::new()).is_ok());
        for key in ["PATH", "Node_Options", "PYTHONPATH", "NPM_CONFIG_REGISTRY"] {
            assert!(validate_config(&config, &BTreeMap::from([(key.into(), "x".into())])).is_err());
        }
        assert!(validate_config(
            &LocalConfig {
                entry_point: "../python.exe".into(),
                ..config
            },
            &BTreeMap::new()
        )
        .is_err());
    }
    #[test]
    fn canonical_paths_cannot_escape_managed_packages() {
        let temp = tempfile::tempdir().unwrap();
        assert!(contained(&temp.path().join("missing"), temp.path()).is_err());
        assert!(package_dir(temp.path(), "..").is_err());
    }
}
