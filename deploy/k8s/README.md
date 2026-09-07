# apicc 服务端 k8s 部署

纯 manifests（无 helm）。前置：本地已构建镜像 `apicc-server:local`
（仓库根 `docker build -t apicc-server:local .`），单节点集群（k3s / minikube / Docker
Desktop k8s）需将其导入节点镜像（如 `k3s image import` / `minikube image load`）。

```bash
# 1. 改管理员口令（secret.yaml 的 stringData），或 kubectl create secret 替代
kubectl apply -f deploy/k8s/configmap.yaml
kubectl apply -f deploy/k8s/secret.yaml
kubectl apply -f deploy/k8s/pvc.yaml
kubectl apply -f deploy/k8s/deployment.yaml
kubectl apply -f deploy/k8s/service.yaml

# 2. 就绪探测
kubectl get pods -l app=apicc-server
curl http://<节点IP>:30080/api/v1/ping   # {"status":"ok"}
```

- 数据：PVC `apicc-server-data`（备份即备份该卷）。
- 升级：`docker build` 出新镜像并导入后 `kubectl rollout restart deploy/apicc-server`。
- Ingress / TLS：本期未含（NodePort 直出），后续需要再补。
