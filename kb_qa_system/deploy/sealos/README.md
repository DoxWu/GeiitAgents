# Sealos/Kubernetes 应用模板

这些文件只覆盖无状态应用和应用使用的 PVC，适合首发单副本架构：

- `geiit-api`：后端 `ROLE=api+worker`，同时提供 FastAPI 和 Celery Worker；
- `geiit-frontend`：Nginx 静态资源和 `/api/`、`/ready` 同源反代；
- `geiit-api-uploads`、`geiit-api-data`：应用上传文件和运行数据；
- PostgreSQL、pgvector 和 Redis 由 Sealos 数据库应用或已验证的托管实例提供，服务名默认是 `kb-qa-postgres` 和 `kb-qa-redis`。

## 使用顺序

1. 先在同一命名空间创建 PostgreSQL/pgvector 和 Redis，确认扩展、版本、密码、PVC 和内网服务名。
2. 复制 `secret.example.yaml` 为未跟踪的 `secret.yaml`，替换所有占位符；不要把真实 Secret 提交到 Git。
3. 将 `kustomization.yaml` 中两个镜像的 `newName`/`newTag` 改为实际不可变镜像引用。建议使用 Git SHA，不使用 `latest`。
4. 先运行模板门禁（允许占位符，但检查 Kustomize 结构）：

   ```bash
   powershell -NoProfile -ExecutionPolicy Bypass -File kb_qa_system/deploy/sealos/preflight.ps1 -Mode template
   ```

5. 填写 `secret.yaml`、镜像引用后运行 ready 门禁；如果部署主机有 Docker daemon，可以同时检查：

   ```bash
   powershell -NoProfile -ExecutionPolicy Bypass -File kb_qa_system/deploy/sealos/preflight.ps1 -Mode ready -CheckDocker
   ```

6. 应用 Secret、PVC 和应用：

   ```bash
   kubectl apply -f kb_qa_system/deploy/sealos/secret.yaml
   kubectl apply -k kb_qa_system/deploy/sealos
   ```

7. 等待就绪并检查反代：

   ```bash
   kubectl rollout status deployment/geiit-api
   kubectl rollout status deployment/geiit-frontend
   kubectl get pvc geiit-api-uploads geiit-api-data
   kubectl port-forward service/geiit-frontend 8080:80
   curl http://127.0.0.1:8080/ready
   ```

## 必须由部署者确认的事项

- `secret.yaml` 中的数据库/Redis URL、模型、Embedding 维度和前端域名与实际环境一致。
- `geiit-api` 与 PostgreSQL/Redis 位于同一命名空间；API 的 `/ready` 只有在数据库和 Redis 均可用时才会通过。
- PVC 的存储类支持当前平台；首发 `ReadWriteOnce` 与单副本 `api+worker` 配套。不要在没有对象存储或 RWX 证据时把 API 扩成多副本。
- Sealos 的域名入口指向 `geiit-frontend` Service；对外只暴露前端，API 保持 ClusterIP。
- `secret.example.yaml` 是占位样例，不是可用生产配置；真实 provider、邮件、备份密钥和管理员初始化必须按部署选型文档单独配置。

这些模板没有执行线上部署，也没有替代目标环境的 pgvector、PVC 重启、真实 provider、邮件、备份恢复和 HTTPS 验收。
