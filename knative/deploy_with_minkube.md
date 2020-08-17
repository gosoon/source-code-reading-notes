在 minikube 上部署 knative

 * [安装 minkube](#安装-minkube)
 * [安装 istio](#安装-istio)
 * [安装 knative](#安装-knative)


### 安装 minkube

```
// 部署 minkube
$ minikube start --image-mirror-country cn \
    --iso-url=https://kubernetes.oss-cn-hangzhou.aliyuncs.com/minikube/iso/minikube-v1.5.0.iso \
    --image-repository=registry.cn-hangzhou.aliyuncs.com/google_containers \
    --container-runtime=containerd \
    --vm-driver=virtualbox \
    --kubernetes-version='v1.17.0' \
    --network-plugin=cni \
    --memory=5120 \
    --cpus=4 \
    --alsologtostderr -v=8

// 安装 cilium 网络查件
$ kubectl create -f https://raw.githubusercontent.com/cilium/cilium/v1.8/install/kubernetes/quick-install.yaml

// 检查 pod 是否正常运行
$ kubectl get pod -n kube-system
NAME                               READY   STATUS    RESTARTS   AGE
cilium-crs5s                       1/1     Running   0          3h40m
cilium-operator-69c684d865-77c9w   1/1     Running   0          3h40m
coredns-7f9c544f75-47x56           1/1     Running   0          3h41m
coredns-7f9c544f75-g95kk           1/1     Running   0          3h41m
etcd-minikube                      1/1     Running   0          3h41m
kube-addon-manager-minikube        1/1     Running   0          3h41m
kube-apiserver-minikube            1/1     Running   0          3h41m
kube-controller-manager-minikube   1/1     Running   0          3h41m
kube-proxy-59zdn                   1/1     Running   0          3h41m
kube-scheduler-minikube            1/1     Running   0          3h41m
storage-provisioner                1/1     Running   0          3h41m
```



### 安装 istio

```
// 下载 istioctl bin 文件
$ curl -L https://istio.io/downloadIstio | sh -

// 使用 istioctl 安装 istio 组件
$ cp istio-1.5.0/bin/istioctl /usr/local/bin/

$ cat << EOF > ./istio-minimal-operator.yaml
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
spec:
  values:
    global:
      proxy:
        autoInject: enabled  // 自动注入 istio sidecar
      useMCP: false
      # The third-party-jwt is not enabled on all k8s.
      # See: https://istio.io/docs/ops/best-practices/security/#configure-third-party-service-account-tokens
      jwtPolicy: first-party-jwt

  addonComponents:
    pilot:
      enabled: true
    prometheus:
      enabled: false

  components:
    ingressGateways:
      - name: istio-ingressgateway
        enabled: true
      - name: cluster-local-gateway
        enabled: true
        label:
          istio: cluster-local-gateway
          app: cluster-local-gateway
        k8s:
          service:
            type: ClusterIP
            ports:
            - port: 15020
              name: status-port
            - port: 80
              name: http2
            - port: 443
              name: https
EOF

$ istioctl manifest apply -f istio-minimal-operator.yaml
```



### 安装 knative

```
// 安装 knative operator
$ kubectl apply -f https://github.com/knative/operator/releases/download/v0.15.0/operator.yaml

// 创建 Knative Serving CR，创建完成后，knative operator 会自动安装 knative 所需要的组件
$ cat <<-EOF | kubectl apply -f -
apiVersion: v1
kind: Namespace
metadata:
 name: knative-serving
---
apiVersion: operator.knative.dev/v1alpha1
kind: KnativeServing
metadata:
  name: knative-serving
  namespace: knative-serving
EOF

// 检查 knative-serving 组件是否正常运行
$ kubectl get deployment -n knative-serving
NAME               READY   UP-TO-DATE   AVAILABLE   AGE
activator          1/1     1            1           3h25m
autoscaler         1/1     1            1           3h25m
autoscaler-hpa     1/1     1            1           3h25m
controller         1/1     1            1           3h25m
istio-webhook      1/1     1            1           3h25m
networking-istio   1/1     1            1           3h25m
webhook            1/1     1            1           3h25m


// 创建 knative-eventing cr
$ cat <<-EOF | kubectl apply -f -
apiVersion: v1
kind: Namespace
metadata:
 name: knative-eventing
---
apiVersion: operator.knative.dev/v1alpha1
kind: KnativeEventing
metadata:
  name: knative-eventing
  namespace: knative-eventing
EOF

// 检查 knative-eventing 组件是否正常运行
$ kubectl get deployment -n knative-eventing
NAME                    READY   UP-TO-DATE   AVAILABLE   AGE
broker-controller       1/1     1            1           3h25m
broker-filter           1/1     1            1           3h25m
broker-ingress          1/1     1            1           3h25m
eventing-controller     1/1     1            1           3h25m
eventing-webhook        1/1     1            1           3h25m
imc-controller          1/1     1            1           3h25m
imc-dispatcher          1/1     1            1           3h25m
mt-broker-controller    1/1     1            1           3h25m
pingsource-mt-adapter   1/1     1            1           109m


// 为 knative-serving namespace 启用 istio sidecar 自动注入功能
$ kubectl label namespace knative-serving istio-injection=enabled

// 启用 Istio mTLS 功能
$ cat <<EOF | kubectl apply -f -
apiVersion: "security.istio.io/v1beta1"
kind: "PeerAuthentication"
metadata:
  name: "default"
  namespace: "knative-serving"
spec:
  mtls:
    mode: PERMISSIVE
EOF

// 安装 knative 客户端工具 kn，类似于 kubectl、istioctl 可以对 kantive 中的资源进行操作
$ curl https://storage.googleapis.com/knative-nightly/client/latest/kn-darwin-amd64
$ cp kn-darwin-amd64 /usr/local/bin/kn
```



参考：

istio 安装：https://knative.dev/development/install/installing-istio/#installing-istio-with-sidecar-injection

knative 安装：https://knative.dev/v0.15-docs/install/knative-with-operators/


