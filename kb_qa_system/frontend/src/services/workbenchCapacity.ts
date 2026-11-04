// Raw images expand by 4/3 in JSON, then again in the encrypted envelope.
// Leave room for existing text/history and the backup wrapper at each stage.
export const MAX_GENERATED_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_RESPONSE_BYTES = 88 * 1024 * 1024;
export const MAX_VAULT_IMAGE_BYTES = 128 * 1024 * 1024;
export const MAX_VAULT_SNAPSHOT_BYTES = 192 * 1024 * 1024;
export const MAX_VAULT_BACKUP_BYTES = 260 * 1024 * 1024;
export const GENERATED_IMAGE_TOO_LARGE = '模型生成图片超过64 MiB接收上限，请降低输出尺寸后重试。';
