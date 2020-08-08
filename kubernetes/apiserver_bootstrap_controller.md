---
title: kube-apiserver 中 apiserver service 的实现
date: 2020-03-04 14:10:30
tags: ["kube-apiserver","bootstrapController"]
type: "kube-apiserver"

---


* [bootstrap controller 源码分析](#bootstrap-controller-源码分析)
   * [NewBootstrapController](#newbootstrapcontroller)
   * [bootstrapController.Start](#bootstrapcontrollerstart)
   * [c.RunKubernetesNamespaces](#crunkubernetesnamespaces)
   * [c.RunKubernetesService](#crunkubernetesservice)
      * [c.UpdateKubernetesService](#cupdatekubernetesservice)
      * [c.EndpointReconciler.ReconcileEndpoints](#cendpointreconcilerreconcileendpoints)
   * [repairClusterIPs.RunUntil](#repairclusteripsrununtil)
   * [repairNodePorts.RunUnti](#repairnodeportsrununti)
* [总结](#总结)



在 kubernetes，可以从集群外部和内部两种方式访问 kubernetes API，在集群外直接访问 apiserver 提供的 API，在集群内即 pod 中可以通过访问 service 为 kubernetes 的 ClusterIP。kubernetes 集群在初始化完成后就会创建一个 kubernetes service，该 service 是 kube-apiserver 创建并进行维护的，如下所示：

```
$ kubectl get service
NAME         TYPE        CLUSTER-IP   EXTERNAL-IP   PORT(S)   AGE
kubernetes   ClusterIP   10.96.0.1    <none>        443/TCP   4d22h

$ kubectl get endpoints kubernetes
NAME         ENDPOINTS             AGE
kubernetes   192.168.99.113:6443   4d22h
```



内置的 kubernetes service 无法删除，其 ClusterIP 为通过 `--service-cluster-ip-range` 参数指定的 ip 段中的首个 ip，kubernetes endpoints 中的 ip 以及 port 可以通过 `--advertise-address` 和 `--secure-port` 启动参数来指定。



kubernetes service 是由 kube-apiserver 中的 bootstrap controller 进行控制的，其主要以下几个功能：

- 创建 kubernetes service；
- 创建 default、kube-system 和 kube-public 命名空间，如果启用了 `NodeLease` 特性还会创建 kube-node-lease 命名空间；
- 提供基于 Service ClusterIP 的修复及检查功能；
- 提供基于 Service NodePort 的修复及检查功能；



kubernetes service 默认使用 ClusterIP 对外暴露服务，若要使用 nodePort 的方式可在 kube-apiserver 启动时通过 `--kubernetes-service-node-port` 参数指定对应的端口。



### bootstrap controller 源码分析

> kubernetes 版本：v1.16



bootstrap controller 的初始化以及启动是在 `CreateKubeAPIServer` 调用链的 `InstallLegacyAPI` 方法中完成的，bootstrap controller 的启停是由 apiserver 的 `PostStartHook` 和 `ShutdownHook` 进行控制的。



`k8s.io/kubernetes/pkg/master/master.go:406`

```
func (m *Master) InstallLegacyAPI(......) error {
    legacyRESTStorage, apiGroupInfo, err := legacyRESTStorageProvider.NewLegacyRESTStorage(restOptionsGetter)
    if err != nil {
        return fmt.Errorf("Error building core storage: %v", err)
    }

    // 初始化 bootstrap-controller
    controllerName := "bootstrap-controller"
    coreClient := corev1client.NewForConfigOrDie(c.GenericConfig.LoopbackClientConfig)
    bootstrapController := c.NewBootstrapController(......)
    m.GenericAPIServer.AddPostStartHookOrDie(controllerName, bootstrapController.PostStartHook)
    m.GenericAPIServer.AddPreShutdownHookOrDie(controllerName, bootstrapController.PreShutdownHook)

    if err := m.GenericAPIServer.InstallLegacyAPIGroup(genericapiserver.DefaultLegacyAPIPrefix, &apiGroupInfo); err != nil {
        return fmt.Errorf("Error in registering group versions: %v", err)
    }
    return nil
}
```

postStartHooks 会在 kube-apiserver 的启动方法 `prepared.Run` 中调用 `RunPostStartHooks` 启动所有 Hook。

#### NewBootstrapController

bootstrap controller 在初始化时需要设定多个参数，主要有 PublicIP、ServiceCIDR、PublicServicePort 等。PublicIP 是通过命令行参数 `--advertise-address` 指定的，如果没有指定，系统会自动选出一个 global IP。PublicServicePort 通过 `--secure-port` 启动参数来指定（默认为 6443），ServiceCIDR 通过 `--service-cluster-ip-range` 参数指定（默认为 10.0.0.0/24）。



`k8s.io/kubernetes/pkg/master/controller.go:89`

```
func (c *completedConfig) NewBootstrapController(......) *Controller {
    // 1、获取 PublicServicePort
    _, publicServicePort, err := c.GenericConfig.SecureServing.HostPort()
    if err != nil {
        klog.Fatalf("failed to get listener address: %v", err)
    }

    // 2、指定需要创建的 kube-system 和 kube-public
    systemNamespaces := []string{metav1.NamespaceSystem, metav1.NamespacePublic}
    if utilfeature.DefaultFeatureGate.Enabled(features.NodeLease) {
        systemNamespaces = append(systemNamespaces, corev1.NamespaceNodeLease)
    }

    return &Controller{
        ......
        // ServiceClusterIPRegistry 是在 CreateKubeAPIServer 初始化 RESTStorage 时初始化的，是一个 etcd 实例
        ServiceClusterIPRegistry:          legacyRESTStorage.ServiceClusterIPAllocator,
        ServiceClusterIPRange:             c.ExtraConfig.ServiceIPRange,
        SecondaryServiceClusterIPRegistry: legacyRESTStorage.SecondaryServiceClusterIPAllocator,

        // SecondaryServiceClusterIPRange 需要在启用 IPv6DualStack 后才能使用
        SecondaryServiceClusterIPRange:    c.ExtraConfig.SecondaryServiceIPRange,

        ServiceClusterIPInterval: 3 * time.Minute,

        ServiceNodePortRegistry: legacyRESTStorage.ServiceNodePortAllocator,
        ServiceNodePortRange:    c.ExtraConfig.ServiceNodePortRange,
        ServiceNodePortInterval: 3 * time.Minute,

        // API Server 绑定的IP，这个IP会作为kubernetes service的Endpoint的IP
        PublicIP: c.GenericConfig.PublicAddress,
        // 取 clusterIP range 中的第一个 IP
        ServiceIP:                 c.ExtraConfig.APIServerServiceIP,
        // 默认为 6443
        ServicePort:               c.ExtraConfig.APIServerServicePort,
        ExtraServicePorts:         c.ExtraConfig.ExtraServicePorts,
        ExtraEndpointPorts:        c.ExtraConfig.ExtraEndpointPorts,
        // 这里为 6443
        PublicServicePort:         publicServicePort,

        // 缺省是基于 ClusterIP 启动模式，这里为0
        KubernetesServiceNodePort: c.ExtraConfig.KubernetesServiceNodePort,
    }
}
```



自动选出 global IP 的代码如下所示：

`k8s.io/kubernetes/staging/src/k8s.io/apimachinery/pkg/util/net/interface.go:323`

```
func ChooseHostInterface() (net.IP, error) {
    var nw networkInterfacer = networkInterface{}
    if _, err := os.Stat(ipv4RouteFile); os.IsNotExist(err) {
        return chooseIPFromHostInterfaces(nw)
    }
    routes, err := getAllDefaultRoutes()
    if err != nil {
        return nil, err
    }
    return chooseHostInterfaceFromRoute(routes, nw)
}
```



#### bootstrapController.Start

上文已经提到了 bootstrap controller 主要的四个功能：修复 ClusterIP、修复 NodePort、更新 kubernetes service、创建系统所需要的名字空间（default、kube-system、kube-public）。bootstrap controller 在启动后首先会完成一次 ClusterIP、NodePort 和 Kubernets 服务的处理，然后异步循环运行上面的4个工作。以下是其 `start` 方法：


`k8s.io/kubernetes/pkg/master/controller.go:146`

```
func (c *Controller) Start() {
    if c.runner != nil {
        return
    }

    // 1、首次启动时首先从 kubernetes endpoints 中移除自身的配置，
    // 此时 kube-apiserver 可能处于非 ready 状态
    endpointPorts := createEndpointPortSpec(c.PublicServicePort, "https", c.ExtraEndpointPorts)
    if err := c.EndpointReconciler.RemoveEndpoints(kubernetesServiceName, c.PublicIP, endpointPorts); err != nil {
        klog.Errorf("Unable to remove old endpoints from kubernetes service: %v", err)
    }

    // 2、初始化 repairClusterIPs 和 repairNodePorts 对象
    repairClusterIPs := servicecontroller.NewRepair(......)
    repairNodePorts := portallocatorcontroller.NewRepair(......)

    // 3、首先运行一次 repairClusterIPs 和 repairNodePorts，即进行初始化
    if err := repairClusterIPs.RunOnce(); err != nil {
        klog.Fatalf("Unable to perform initial IP allocation check: %v", err)
    }
    if err := repairNodePorts.RunOnce(); err != nil {
        klog.Fatalf("Unable to perform initial service nodePort check: %v", err)
    }
    // 4、定期执行 bootstrap controller 主要的四个功能
    c.runner = async.NewRunner(c.RunKubernetesNamespaces, c.RunKubernetesService, repairClusterIPs.RunUntil, repairNodePorts.RunUntil)
    c.runner.Start()
}
```



#### c.RunKubernetesNamespaces

`c.RunKubernetesNamespaces` 主要功能是创建 kube-system 和 kube-public 命名空间，如果启用了 `NodeLease`  特性功能还会创建 kube-node-lease 命名空间，之后每隔一分钟检查一次。



`k8s.io/kubernetes/pkg/master/controller.go:199`

```
func (c *Controller) RunKubernetesNamespaces(ch chan struct{}) {
    wait.Until(func() {
        for _, ns := range c.SystemNamespaces {
            if err := createNamespaceIfNeeded(c.NamespaceClient, ns); err != nil {
                runtime.HandleError(fmt.Errorf("unable to create required kubernetes system namespace %s: %v", ns, err))
            }
        }
    }, c.SystemNamespacesInterval, ch)
}
```



#### c.RunKubernetesService

`c.RunKubernetesService` 主要是检查 kubernetes service 是否处于正常状态，并定期执行同步操作。首先调用  `/healthz` 接口检查 apiserver 当前是否处于 ready 状态，若处于 ready 状态然后调用 `c.UpdateKubernetesService` 服务更新 kubernetes service 状态。



`k8s.io/kubernetes/pkg/master/controller.go:210`

```
func (c *Controller) RunKubernetesService(ch chan struct{}) {
    wait.PollImmediateUntil(100*time.Millisecond, func() (bool, error) {
        var code int
        c.healthClient.Get().AbsPath("/healthz").Do().StatusCode(&code)
        return code == http.StatusOK, nil
    }, ch)

    wait.NonSlidingUntil(func() {
        if err := c.UpdateKubernetesService(false); err != nil {
            runtime.HandleError(fmt.Errorf("unable to sync kubernetes service: %v", err))
        }
    }, c.EndpointInterval, ch)
}
```



##### c.UpdateKubernetesService

`c.UpdateKubernetesService` 的主要逻辑为：

- 1、调用 `createNamespaceIfNeeded` 创建 default namespace；
- 2、调用 `c.CreateOrUpdateMasterServiceIfNeeded` 为 master 创建 kubernetes service；
- 3、调用 `c.EndpointReconciler.ReconcileEndpoints` 更新 master 的 endpoint；


`k8s.io/kubernetes/pkg/master/controller.go:230`

```
func (c *Controller) UpdateKubernetesService(reconcile bool) error {
    if err := createNamespaceIfNeeded(c.NamespaceClient, metav1.NamespaceDefault); err != nil {
        return err
    }

    servicePorts, serviceType := createPortAndServiceSpec(c.ServicePort, c.PublicServicePort, c.KubernetesServiceNodePort, "https", c.ExtraServicePorts)
    if err := c.CreateOrUpdateMasterServiceIfNeeded(kubernetesServiceName, c.ServiceIP, servicePorts, serviceType, reconcile); err != nil {
    		return err
    }
    endpointPorts := createEndpointPortSpec(c.PublicServicePort, "https", c.ExtraEndpointPorts)
    if err := c.EndpointReconciler.ReconcileEndpoints(kubernetesServiceName, c.PublicIP, endpointPorts, reconcile); err != nil {
        return err
    }
    return nil
}
```



##### c.EndpointReconciler.ReconcileEndpoints

EndpointReconciler 的具体实现由 `EndpointReconcilerType` 决定，`EndpointReconcilerType` 是 `--endpoint-reconciler-type` 参数指定的，可选的参数有 `master-count, lease, none`，每种类型对应不同的 EndpointReconciler 实例，在 v1.16 中默认为 lease，此处仅分析 lease 对应的 EndpointReconciler 的实现。



一个集群中可能会有多个 apiserver 实例，因此需要统一管理 apiserver service 的 endpoints，`c.EndpointReconciler.ReconcileEndpoints` 就是用来管理 apiserver endpoints 的。一个集群中 apiserver 的所有实例会在 etcd 中的对应目录下创建 key，并定期更新这个 key 来上报自己的心跳信息，ReconcileEndpoints 会从 etcd 中获取 apiserver 的实例信息并更新 endpoint。



`k8s.io/kubernetes/pkg/master/reconcilers/lease.go:144`

```
func (r *leaseEndpointReconciler) ReconcileEndpoints(......) error {
    r.reconcilingLock.Lock()
    defer r.reconcilingLock.Unlock()

    if r.stopReconcilingCalled {
        return nil
    }

    // 更新 lease 信息
    if err := r.masterLeases.UpdateLease(ip.String()); err != nil {
        return err
    }

    return r.doReconcile(serviceName, endpointPorts, reconcilePorts)
}
func (r *leaseEndpointReconciler) doReconcile(......) error {
    // 1、获取 master 的 endpoint
    e, err := r.epAdapter.Get(corev1.NamespaceDefault, serviceName, metav1.GetOptions{})
    shouldCreate := false
    if err != nil {
        if !errors.IsNotFound(err) {
            return err
        }

        shouldCreate = true
        e = &corev1.Endpoints{
            ObjectMeta: metav1.ObjectMeta{
                Name:      serviceName,
                Namespace: corev1.NamespaceDefault,
            },
        }
    }

    // 2、从 etcd 中获取所有的 master
    masterIPs, err := r.masterLeases.ListLeases()
    if err != nil {
        return err
    }

    if len(masterIPs) == 0 {
        return fmt.Errorf("no master IPs were listed in storage, refusing to erase all endpoints for the kubernetes service")
    }

    // 3、检查 endpoint 中 master 信息，如果与 etcd 中的不一致则进行更新
    formatCorrect, ipCorrect, portsCorrect := checkEndpointSubsetFormatWithLease(e, masterIPs, endpointPorts, reconcilePorts)
    if formatCorrect && ipCorrect && portsCorrect {
        return nil
    }

    if !formatCorrect {
        e.Subsets = []corev1.EndpointSubset{{
            Addresses: []corev1.EndpointAddress{},
            Ports:     endpointPorts,
        }}
    }
    if !formatCorrect || !ipCorrect {
        e.Subsets[0].Addresses = make([]corev1.EndpointAddress, len(masterIPs))
        for ind, ip := range masterIPs {
            e.Subsets[0].Addresses[ind] = corev1.EndpointAddress{IP: ip}
        }

        e.Subsets = endpointsv1.RepackSubsets(e.Subsets)
    }

    if !portsCorrect {
        e.Subsets[0].Ports = endpointPorts
    }

    if shouldCreate {
        if _, err = r.epAdapter.Create(corev1.NamespaceDefault, e); errors.IsAlreadyExists(err) {
            err = nil
        }
    } else {
        _, err = r.epAdapter.Update(corev1.NamespaceDefault, e)
    }
    return err
}
```



#### repairClusterIPs.RunUntil

repairClusterIP 主要解决的问题有：

- 保证集群中所有的  ClusterIP 都是唯一分配的；
- 保证分配的 ClusterIP 不会超出指定范围；
- 确保已经分配给 service 但是因为 crash 等其他原因没有正确创建 ClusterIP；
- 自动将旧版本的 Kubernetes services 迁移到 ipallocator 原子性模型；

`repairClusterIPs.RunUntil` 其实是调用 `repairClusterIPs.runOnce` 来处理的，其代码中的主要逻辑如下所示：



`k8s.io/kubernetes/pkg/registry/core/service/ipallocator/controller/repair.go:134`

```
func (c *Repair) runOnce() error {
    ......

    // 1、首先从 etcd 中获取已经使用 ClusterIP 的快照
    err = wait.PollImmediate(time.Second, 10*time.Second, func() (bool, error) {
        var err error
        snapshot, err = c.alloc.Get()
        if err != nil {
            return false, err
        }

        if c.shouldWorkOnSecondary() {
            secondarySnapshot, err = c.secondaryAlloc.Get()
            if err != nil {
                return false, err
            }
        }
        return true, nil
    })
    if err != nil {
        return fmt.Errorf("unable to refresh the service IP block: %v", err)
    }
    // 2、判断 snapshot 是否已经初始化
    if snapshot.Range == "" {
        snapshot.Range = c.network.String()
    }

    if c.shouldWorkOnSecondary() && secondarySnapshot.Range == "" {
        secondarySnapshot.Range = c.secondaryNetwork.String()
    }

    stored, err = ipallocator.NewFromSnapshot(snapshot)
    if c.shouldWorkOnSecondary() {
        secondaryStored, secondaryErr = ipallocator.NewFromSnapshot(secondarySnapshot)
    }

    if err != nil || secondaryErr != nil {
        return fmt.Errorf("unable to rebuild allocator from snapshots: %v", err)
    }
    // 3、获取 service list
    list, err := c.serviceClient.Services(metav1.NamespaceAll).List(metav1.ListOptions{})
    if err != nil {
        return fmt.Errorf("unable to refresh the service IP block: %v", err)
    }

    // 4、将 CIDR 转换为对应的 IP range 格式
    var rebuilt, secondaryRebuilt *ipallocator.Range
    rebuilt, err = ipallocator.NewCIDRRange(c.network)

    ......

    // 5、检查每个 Service 的 ClusterIP，保证其处于正常状态
    for _, svc := range list.Items {
        if !helper.IsServiceIPSet(&svc) {
            continue
        }
        ip := net.ParseIP(svc.Spec.ClusterIP)
        ......

        actualAlloc := c.selectAllocForIP(ip, rebuilt, secondaryRebuilt)
        switch err := actualAlloc.Allocate(ip); err {
        // 6、检查 ip 是否泄漏
        case nil:
            actualStored := c.selectAllocForIP(ip, stored, secondaryStored)
            if actualStored.Has(ip) {
                actualStored.Release(ip)
            } else {
                ......
            }
            delete(c.leaks, ip.String())
        // 7、ip 重复分配
        case ipallocator.ErrAllocated:
            ......
        // 8、ip 超出范围
        case err.(*ipallocator.ErrNotInRange):
            ......
        // 9、ip 已经分配完
        case ipallocator.ErrFull:
            ......
        default:
            ......
        }
    }
    // 10、对比是否有泄漏 ip
    c.checkLeaked(stored, rebuilt)
    if c.shouldWorkOnSecondary() {
        c.checkLeaked(secondaryStored, secondaryRebuilt)
    }

    // 11、更新快照
    err = c.saveSnapShot(rebuilt, c.alloc, snapshot)
    if err != nil {
        return err
    }

    if c.shouldWorkOnSecondary() {
        err := c.saveSnapShot(secondaryRebuilt, c.secondaryAlloc, secondarySnapshot)
        if err != nil {
            return nil
        }
    }
    return nil
}
```



#### repairNodePorts.RunUntil

repairNodePorts 主要是用来纠正 service 中 nodePort 的信息，保证所有的 ports 都基于 cluster 创建的，当没有与 cluster 同步时会触发告警，其最终是调用 `repairNodePorts.runOnce` 进行处理的，主要逻辑与 ClusterIP 的处理逻辑类似。


`k8s.io/kubernetes/pkg/registry/core/service/portallocator/controller/repair.go:84`

```
func (c *Repair) runOnce() error {
    // 1、首先从 etcd 中获取已使用 nodeport 的快照
    err := wait.PollImmediate(time.Second, 10*time.Second, func() (bool, error) {
        var err error
        snapshot, err = c.alloc.Get()
        return err == nil, err
    })
    if err != nil {
        return fmt.Errorf("unable to refresh the port allocations: %v", err)
    }
    // 2、检查 snapshot 是否初始化
    if snapshot.Range == "" {
        snapshot.Range = c.portRange.String()
    }
    // 3、获取已分配 nodePort 信息
    stored, err := portallocator.NewFromSnapshot(snapshot)
    if err != nil {
        return fmt.Errorf("unable to rebuild allocator from snapshot: %v", err)
    }
    // 4、获取 service list
    list, err := c.serviceClient.Services(metav1.NamespaceAll).List(metav1.ListOptions{})
    if err != nil {
        return fmt.Errorf("unable to refresh the port block: %v", err)
    }

    rebuilt, err := portallocator.NewPortAllocator(c.portRange)
    if err != nil {
        return fmt.Errorf("unable to create port allocator: %v", err)
    }

    // 5、检查每个 Service ClusterIP 的 port，保证其处于正常状态
    for i := range list.Items {
        svc := &list.Items[i]
        ports := collectServiceNodePorts(svc)
        if len(ports) == 0 {
            continue
        }
        for _, port := range ports {
            switch err := rebuilt.Allocate(port); err {
            // 6、检查 port 是否泄漏
            case nil:
                if stored.Has(port) {
                    stored.Release(port)
                } else {
                    ......
                }
                delete(c.leaks, port)
            // 7、port 重复分配
            case portallocator.ErrAllocated:
                ......
            // 8、port 超出分配范围
            case err.(*portallocator.ErrNotInRange):
                ......
            // 9、port 已经分配完
            case portallocator.ErrFull:
                ......
            default:
                ......
            }
        }
    }
    // 10、检查 port 是否泄漏
    stored.ForEach(func(port int) {
        count, found := c.leaks[port]
        switch {
        case !found:
            ......
            count = numRepairsBeforeLeakCleanup - 1
            fallthrough
        case count > 0:
            c.leaks[port] = count - 1
            if err := rebuilt.Allocate(port); err != nil {
                runtime.HandleError(fmt.Errorf("the node port %d may have leaked, but can not be allocated: %v", port, err))
            }
        default:
            ......
        }
    })

    // 11、更新 snapshot
    if err := rebuilt.Snapshot(snapshot); err != nil {
        return fmt.Errorf("unable to snapshot the updated port allocations: %v", err)
    }
    ......
    return nil
}
```



以上就是 bootstrap controller 的主要实现。




### 总结

本文主要分析了 kube-apiserver 中 apiserver service 的实现，apiserver service 是通过  bootstrap controller 控制的，bootstrap controller 会保证 apiserver service 以及其 endpoint 处于正常状态，需要注意的是，apiserver service 的 endpoint 根据启动时指定的参数分为三种控制方式，本文仅分析了 lease 的实现方式，如果使用 master-count 方式，需要将每个 master 实例的 port、apiserver-count 等配置参数改为一致。



