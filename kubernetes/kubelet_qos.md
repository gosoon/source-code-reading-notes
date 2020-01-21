---
title: kubernetes 中 Qos 的设计与实现
date: 2020-01-21 16:28:30
tags: ["kubelet","qos","cgroup"]
type: "kubelet"

---


* [kubernetes 中的 Qos](#kubernetes-中的-qos)
   * [不同 Qos 的本质区别](#不同-qos-的本质区别)
* [启用 Qos 和 Pod level cgroup](#启用-qos-和-pod-level-cgroup)
   * [配置 cgroup driver](#配置-cgroup-driver)
* [kubernetes 中的 cgroup level](#kubernetes-中的-cgroup-level)
   * [Container level cgroups](#container-level-cgroups)
   * [Pod level cgroups](#pod-level-cgroups)
      * [Guaranteed Pod QoS](#guaranteed-pod-qos)
      * [Burstable Pod QoS](#burstable-pod-qos)
      * [BestEffort Pod QoS](#besteffort-pod-qos)
   * [QoS level cgroups](#qos-level-cgroups)
   * [小结](#小结)
* [QOSContainerManager 源码分析](#qoscontainermanager-源码分析)
   * [qosContainerManager 的初始化](#qoscontainermanager-的初始化)
   * [qosContainerManager 的启动](#qoscontainermanager-的启动)
      * [cm.setupNode](#cmsetupnode)
      * [cm.qosContainerManager.Start](#cmqoscontainermanagerstart)
      * [m.UpdateCgroups](#mupdatecgroups)
      * [m.cgroupManager.Update](#mcgroupmanagerupdate)
         * [setSupportedSubsystem](#setsupportedsubsystem)
   * [Pod Level Cgroup](#pod-level-cgroup)
   * [Container Level Cgroup](#container-level-cgroup)
* [总结](#总结)



### kubernetes 中的 Qos

QoS(Quality of Service) 即服务质量，QoS 是一种控制机制，它提供了针对不同用户或者不同数据流采用相应不同的优先级，或者是根据应用程序的要求，保证数据流的性能达到一定的水准。kubernetes 中有三种 Qos，分别为：
- 1、`Guaranteed`：pod 的 requests 与 limits 设定的值相等；
- 2、`Burstable`：pod requests 小于 limits 的值且不为 0；
- 3、`BestEffort`：pod 的 requests 与 limits 均为 0；

三者的优先级如下所示，依次递增：

```
BestEffort -> Burstable -> Guaranteed
```



#### 不同 Qos 的本质区别

三种 Qos 在调度和底层表现上都不一样：

- 1、在调度时调度器只会根据 request 值进行调度；
- 2、二是当系统 OOM上时对于处理不同 OOMScore 的进程表现不同，OOMScore 是针对 memory 的，当宿主上 memory 不足时系统会优先 kill 掉 OOMScore 值低的进程，可以使用  `$ cat /proc/$PID/oom_score` 查看进程的 OOMScore。OOMScore 的取值范围为 [-1000, 1000]，`Guaranteed` pod 的默认值为 -998，`Burstable` pod 的值为 2~999，`BestEffort` pod 的值为 1000，也就是说当系统 OOM 时，首先会 kill 掉 `BestEffort` pod 的进程，若系统依然处于 OOM 状态，然后才会 kill 掉  `Burstable` pod，最后是 `Guaranteed` pod；
- 3、三是 cgroup 的配置不同，kubelet 为会三种 Qos 分别创建对应的 QoS level cgroups，`Guaranteed` Pod Qos 的 cgroup level 会直接创建在 `RootCgroup/kubepods` 下，`Burstable` Pod Qos 的创建在 `RootCgroup/kubepods/burstable` 下，`BestEffort` Pod Qos 的创建在 `RootCgroup/kubepods/BestEffort` 下，上文已经说了  root cgroup 可以通过 `$ mount | grep cgroup`看到，在 cgroup 的每个子系统下都会创建 Qos level cgroups， 此外在对应的 QoS level cgroups 还会为 pod 创建 Pod level cgroups；



### 启用 Qos 和 Pod level cgroup

在 kubernetes 中为了限制容器资源的使用，避免容器之间争抢资源或者容器影响所在的宿主机，kubelet 组件需要使用 cgroup 限制容器资源的使用量，cgroup 目前支持对进程多种资源的限制，而 kubelet 只支持限制 cpu、memory、pids、hugetlb 几种资源，与此资源有关的几个参数如下所示：

`--cgroups-per-qos`：启用后会为每个 pod 以及 pod 对应的 Qos 创建 cgroups 层级树，默认启用；

`--cgroup-root`：指定 root cgroup，如果不指定默认为“”，若为默认值则直接使用 root cgroup dir，在 node 上执行 `$ mount | grep cgroup` 可以看到 cgroup 所有子系统的挂载点，这些挂载点就是 root cgroup；

`--cpu-manager-policy`：默认为 "none"，即默认不开启 ,支持使用 "static"，开启后可以支持对 `Guaranteed` Pod 进行绑核操作，绑核的主要目的是为了高效使用 cpu cache 以及内存节点；

`--kube-reserved`：为 kubernetes 系统组件设置预留资源值，可以设置 cpu、memory、ephemeral-storage；

`--kube-reserved-cgroup`：指定 kube-reserved 的 cgroup dir name，默认为 “/kube-reserved”；

`--system-reserved`：为非 kubernetes 组件设置预留资源值，可以设置 cpu、memory、ephemeral-storage；

`--system-reserved-cgroup`：设置 system-reserved 的 cgroup dir name，默认为 “/system-reserved”；

`--qos-reserved`：Alpha feature，可以通过此参数为高优先级 pod 设置预留资源比例，目前只支持预留 memory，使用前需要开启 QOSReserved feature gate；



当启用了 `--cgroups-per-qos` 后，kubelet 会为不同 Qos 创建对应的 level cgroups，在 Qos level cgroups 下也会为 pod 创建对应的 pod level cgroups，在 pod level cgroups 下最终会为 container 创建对应的 level cgroups，从 Qos --> pod --> container，层层限制每个 level cgroups 的资源使用量。

#### 配置 cgroup driver

runtime 有两种 cgroup 驱动：一种是 `systemd`，另外一种是 `cgroupfs`：

- `cgroupfs` 比较好理解，比如说要限制内存是多少、要用 CPU share 为多少，其实直接把 pid 写入到对应cgroup task 文件中，然后把对应需要限制的资源也写入相应的 memory cgroup 文件和 CPU 的 cgroup 文件就可以了；
- 另外一个是 `systemd` 的 cgroup 驱动，这个驱动是因为 `systemd` 本身可以提供一个 cgroup 管理方式。所以如果用 `systemd` 做 cgroup 驱动的话，所有的写 cgroup 操作都必须通过 systemd 的接口来完成，不能手动更改 cgroup 的文件；

kubernetes 中默认 kubelet 的 cgroup 驱动就是 `cgroupfs`，若要使用 `systemd`，则必须将 kubelet 以及 runtime 都需要配置为 `systemd` 驱动。

> 关于 cgroupfs 与 systemd driver 的区别可以参考 k8s 官方文档：[container-runtimes/#cgroup-drivers](https://kubernetes.io/docs/setup/production-environment/container-runtimes/#cgroup-drivers)，或者 runc 中的实现 [github.com/opencontainers/runc/libcontainer/cgroups](https://github.com/opencontainers/runc/tree/master/libcontainer/cgroups)。



### kubernetes 中的 cgroup level

kubelet 启动后会在 root cgroup 下面创建一个叫做 `kubepods` 子 cgroup，kubelet 会把本机的 allocatable 资源写入到 `kubepods` 下对应的 cgroup 文件中，比如 `kubepods/cpu.share`，而这个 cgroup 下面也会存放节点上面所有 pod 的 cgroup，以此来达到限制节点上所有 pod 资源的目的。在 `kubepods` cgroup 下面，kubernetes 会进一步再分别创建两个 QoS level cgroup，名字分别叫做 `burstable` 和 `besteffort`，这两个 QoS level 的 cgroup 是作为各自 QoS 级别的所有 Pod 的父 cgroup 来存在的，在为 pod 创建 cgroup 时，首先在对应的 Qos cgroup 下创建 pod level cgroup，然后在 pod level cgroup 继续创建对应的 container level cgroup，对于 `Guaranteed` Qos 对应的 pod 会直接在 `kubepods` 同级的 cgroup 中创建 pod cgroup。

目前 kubernetes 仅支持  cpu、memory、pids 、hugetlb 四个 cgroup 子系统。

当 kubernetes 在收到一个 pod 的资源申请信息后通过 kubelet 为 pod 分配资源，kubelet 基于 pod 申请的资源以及 pod 对应的 QoS 级别来通过 cgroup 机制最终为这个 pod 分配资源的，针对每一种资源，它会做以下几件事情：
- 首先判断 pod 属于哪种 Qos，在对应的 Qos level cgroup 下对 pod 中的每一个容器在 cgroup 所有子系统下都创建一个 pod level cgroup 以及 container level cgroup，并且 pod level cgroup 是 container level cgroup 的父 cgroup，Qos level cgroup 在 kubelet 初始化时已经创建完成了；
- 然后根据 pod 的资源信息更新 QoS level cgroup 中的值；
- 最后会更新 `kubepods` level cgroup 中的值；

对于每一个 pod 设定的 requests 和 limits，kubernetes 都会转换为 cgroup 中的计算方式，CPU 的转换方式如下所示：
- cpu.shares = (cpu in millicores * 1024) / 1000
- cpu.cfs_period_us = 100000 (i.e. 100ms)
- cpu.cfs_quota_us = quota = (cpu in millicores * 100000) / 1000
- memory.limit_in_bytes

CPU 最终都会转换为以微秒为单位，memory 会转换为以 bytes 为单位。



以下是 kubernetes 中的 cgroup level 的一个示例，此处仅展示 cpu、memory 对应的子 cgroup：

```
.
|-- blkio
|-- cpu -> cpu,cpuacct
|-- cpu,cpuacct
|   |-- init.scope
|   |-- kubepods
|   |   |-- besteffort
|   |   |-- burstable
|   |   `-- podd15c4b83-c250-4f1e-94ff-8a4bf31c6f25
|   |-- system.slice
|   `-- user.slice
|-- cpuacct -> cpu,cpuacct
|-- cpuset
|   |-- kubepods
|   |   |-- besteffort
|   |   |-- burstable
|   |   `-- podd15c4b83-c250-4f1e-94ff-8a4bf31c6f25
|-- devices
|-- hugetlb
|-- memory
|   |-- init.scope
|   |-- kubepods
|   |   |-- besteffort
|   |   |-- burstable
|   |   `-- podd15c4b83-c250-4f1e-94ff-8a4bf31c6f25
|   |-- system.slice
|   |   |-- -.mount
|   `-- user.slice
|-- net_cls -> net_cls,net_prio
|-- net_cls,net_prio
|-- net_prio -> net_cls,net_prio
|-- perf_event
|-- pids
`-- systemd
```



![](http://cdn.tianfeiyu.com/image-20200120164659896.png)

例如，当创建资源如下所示的 pod：

```
spec:
  containers:
  - name: nginx
    image: nginx:latest
    imagePullPolicy: IfNotPresent
    resources:
      requests:
        cpu: 250m
        memory: 1Gi
      limits:
        cpu: 500m
        memory: 2Gi
```

首先会根据 pod 的 Qos 该 pod 为 burstable 在其所属 Qos 下创建 `ROOT/kubepods/burstable/pod<UID>/container<UID>` 两个 cgroup level，然后会更新 pod 的父 cgroup 也就是 `burstable/` cgroup 中的值，最后会更新 `kubepods` cgroup 中的值，下面会针对每个 cgroup level 一一进行解释。

#### Container level cgroups

在 Container level cgroups 中，kubelet 会根据上述公式将 pod 中每个 container 的资源转换为 cgroup 中的值并写入到对应的文件中。

```
/sys/fs/cgroup/cpu/kubepods/burstable/pod<UID>/container<UID>/cpu.shares = 256
/sys/fs/cgroup/cpu/kubepods/burstable/pod<UID>/container<UID>/cpu.cfs_quota_us = 50000
/sys/fs/cgroup/memory/kubepods/burstable/pod<UID>/container<UID>/memory.limit_in_bytes = 104857600
```



#### Pod level cgroups

在创建完 container level 的 cgroup 之后，kubelet 会为同属于某个 pod 的 containers 创建一个 pod level cgroup。为何要引入 pod level cgroup，主要是基于以下几点原因：
- 方便对 pod 内的容器资源进行统一的限制；
- 方便对 pod 使用的资源进行统一统计；


对于不同 Pod level cgroups 的设置方法如下所示：

##### Guaranteed Pod QoS

```
pod<UID>/cpu.shares = sum(pod.spec.containers.resources.requests[cpu])
pod<UID>/cpu.cfs_period_us = 100000
pod<UID>/cpu.cfs_quota_us = sum(pod.spec.containers.resources.limits[cpu])
pod<UID>/memory.limit_in_bytes = sum(pod.spec.containers.resources.limits[memory])
```

##### Burstable Pod QoS

```
pod<UID>/cpu.shares = sum(pod.spec.containers.resources.requests[cpu])
pod<UID>/cpu.cfs_period_us = 100000
pod<UID>/cpu.cfs_quota_us = sum(pod.spec.containers.resources.limits[cpu])
pod<UID>/memory.limit_in_bytes = sum(pod.spec.containers.resources.limits[memory])
```

##### BestEffort Pod QoS

```
pod<UID>/cpu.shares = 2
pod<UID>/cpu.cfs_quota_us = -1
```



`cpu.shares` 指定了 cpu 可以使用的下限，cpu 的上限通过使用 `cpu.cfs_period_us + cpu.cfs_quota_us` 两个参数做动态绝对配额，两个参数的意义如下所示：
- cpu.cfs_period_us：指 cpu 使用时间的周期统计；
- cpu.cfs_quota_us：指周期内允许占用的 cpu 时间(指单核的时间, 多核则需要在设置时累加) ；

container runtime 中 `cpu.cfs_period_us` 的值默认为 100000。若 kubelet 启用了 `--cpu-manager-policy=static` 时，对于 `Guaranteed` Qos，如果它的 request 是一个整数的话，cgroup 会同时设置 `cpuset.cpus` 和 `cpuset.mems` 两个参数以此来对它进行绑核。


如果 pod 指定了 requests 和 limits，kubelet 会按以上的计算方式为 pod 设置资源限制，如果没有指定 limit 的话，那么 `cpu.cfs_quota_us` 将会被设置为 -1，即没有限制。而如果 limit 和 request 都没有指定的话，`cpu.shares` 将会被指定为 2，这个是 `cpu.shares` 允许指定的最小数值了，可见针对这种 pod，kubernetes 只会给它分配最少的 cpu 资源。而对于内存来说，如果没有 limit 的指定的话，`memory.limit_in_bytes` 将会被指定为一个非常大的值，一般是 2^64 ，可见含义就是不对内存做出限制。



针对上面的例子，其 pod level cgroups 中的配置如下所示：

```
pod<UID>/cpu.shares = 102
pod<UID>/cpu.cfs_quota_us = 20000
```



#### QoS level cgroups

上文已经提到了 kubelet 会首先创建 kubepods cgroup，然后会在 kubepods cgroup 下面再分别创建 burstable 和 besteffort 两个 QoS level cgroup，那么这两个 QoS level cgroup 存在的目的是什么？为什么不为 guaranteed Qos 创建 cgroup level？


首先看一下三种 QoS level cgroups 的设置方法，对于 guaranteed Qos 因其直接使用 root cgroup，此处只看另外两种的计算方式：

`Burstable cgroup`：

```
ROOT/burstable/cpu.shares = max(sum(Burstable pods cpu requests）, 2)
ROOT/burstable/memory.limit_in_bytes =
    Node.Allocatable - {(summation of memory requests of `Guaranteed` pods)*(reservePercent / 100)}
```

`BestEffort cgroup`：

```
ROOT/besteffort/cpu.shares = 2
ROOT/besteffort/memory.limit_in_bytes =
    Node.Allocatable - {(summation of memory requests of all `Guaranteed` and `Burstable` pods)*(reservePercent / 100)}
```



首先第一个问题，所有 guaranteed 级别的 pod 的 cgroup 直接位于 kubepods 这个 cgroup 之下，和 burstable、besteffort QoS level cgroup 同级，主要原因在于 guaranteed 级别的 pod 有明确的资源申请量(request)和资源限制量(limit)，所以并不需要一个统一的 QoS level 的 cgroup 进行管理或限制。

针对 burstable 和 besteffort 这两种类型的 pod，在默认情况下，kubernetes 则是希望能尽可能地提升资源利用率，所以并不会对这两种 QoS 的 pod 的资源使用做限制。但在某些场景下我们还是希望能够尽可能保证 guaranteed level pod 这种高 QoS 级别 pod 的资源，尤其是不可压缩资源（如内存），不要被低 QoS 级别的 pod 抢占，导致高 QoS 级别的 pod 连它 request 的资源量的资源都无法得到满足，此时就可以使用 `--qos-reserved` 为高 Qos pod 进行预留资源，举个例子，当前机器的 allocatable 内存资源量为 8G，当为这台机器的 kubelet 开启 `--qos-reserved` 参数后，并且设置为 memory=100%，如果此时创建了一个内存 request 为 1G 的 guaranteed level 的 pod，那么需要预留的资源就是 1G，此时这台机器上面的 burstable QoS level cgroup 的 `memory.limit_in_bytes` 的值将会被设置为 7G，besteffort QoS level cgroup 的 `memory.limit_in_bytes` 的值也会被设置为 7G。而如果此时又创建了一个 burstable level 的 pod，它的内存申请量为 2G，那么此时需要预留的资源为 3G，而 besteffort QoS level cgroup 的 `memory.limit_in_bytes` 的值也会被调整为 5G。

由上面的公式也可以看到，burstable 的 cgroup 需要为比他等级高的 guaranteed 级别的 pod 的内存资源做预留，而 besteffort 需要为 burstable 和 guaranteed 都要预留内存资源。



#### 小结

kubelet 启动时首先会创建 root cgroups 以及为 Qos 创建对应的 level cgroups，然后当 pod 调度到节点上时，kubelet 也会为 pod 以及 pod 下的 container 创建对应的 level cgroups。root cgroups 限制节点上所有 pod 的资源使用量，Qos  level cgroups 限制不同 Qos 下 pod 的资源使用量，Pod  level cgroups 限制一个 pod 下的资源使用量，Container level cgroups 限制 pod 下 container 的资源使用量。



节点上 cgroup 层级树如下所示：

```
$ROOT
  |
  +- Pod1
  |   |
  |   +- Container1
  |   +- Container2
  |   ...
  +- Pod2
  |   +- Container3
  |   ...
  +- ...
  |
  +- burstable
  |   |
  |   +- Pod3
  |   |   |
  |   |   +- Container4
  |   |   ...
  |   +- Pod4
  |   |   +- Container5
  |   |   ...
  |   +- ...
  |
  +- besteffort
  |   |
  |   +- Pod5
  |   |   |
  |   |   +- Container6
  |   |   +- Container7
  |   |   ...
  |   +- ...
```



### QOSContainerManager 源码分析

> kubernetes 版本：v1.16

qos 的具体实现是在 kubelet 中的 `QOSContainerManager`，`QOSContainerManager` 被包含在 `containerManager` 模块中，kubelet 的 `containerManager` 模块中包含多个模块还有，`cgroupManager`、`containerManager`、`nodeContainerManager`、`podContainerManager`、`topologyManager`、`deviceManager`、`cpuManager` 等。



#### qosContainerManager 的初始化

首先看 `QOSContainerManager` 的初始化，因为 `QOSContainerManager` 包含在 `containerManager` 中，在初始化 `containerManager` 时也会初始化 `QOSContainerManager`。



`k8s.io/kubernetes/cmd/kubelet/app/server.go:471`

```
func run(s *options.KubeletServer, kubeDeps *kubelet.Dependencies, stopCh <-chan struct{}) (err error) {
	......
	kubeDeps.ContainerManager, err = cm.NewContainerManager(......)
	......
}
```



`k8s.io/kubernetes/pkg/kubelet/cm/container_manager_linux.go:200`

```
// 在 NewContainerManager 中会初始化 qosContainerManager
func NewContainerManager(......) (ContainerManager, error) {
    ......
    qosContainerManager, err := NewQOSContainerManager(subsystems, cgroupRoot, nodeConfig, cgroupManager)
    if err != nil {
        return nil, err
    }
    ......
}
```

#### qosContainerManager 的启动

在调用 `kl.containerManager.Start` 启动 `containerManager` 时也会启动 `qosContainerManager`，代码如下所示：

`k8s.io/kubernetes/pkg/kubelet/kubelet.go:1361`

```
func (kl *Kubelet) initializeRuntimeDependentModules() {
    ......
    if err := kl.containerManager.Start(node, kl.GetActivePods, kl.sourcesReady, kl.statusManager, kl.runtimeService); err != nil {
        klog.Fatalf("Failed to start ContainerManager %v", err)
    }
    ......
}
```



##### cm.setupNode

`cm.setupNode` 是启动 `qosContainerManager` 的方法，其主要逻辑为：
- 1、检查 kubelet 依赖的内核参数是否配置正确；
- 2、若 `CgroupsPerQOS` 为 true，首先调用 `cm.createNodeAllocatableCgroups` 创建 root cgroup，然后调用 `cm.qosContainerManager.Start` 启动 `qosContainerManager`；
- 3、调用 `cm.enforceNodeAllocatableCgroups` 计算 node 的 allocatable 资源并配置到 root cgroup 中，然后判断是否启用了 `SystemReserved` 以及 `KubeReserved` 并配置对应的 cgroup；
- 4、为系统组件配置对应的 cgroup 资源限制；
- 5、为系统进程配置 oom_score_adj；



`k8s.io/kubernetes/pkg/kubelet/cm/container_manager_linux.go:568`

```
func (cm *containerManagerImpl) Start(......) {
    ......
    if err := cm.setupNode(activePods); err != nil {
        return err
    }
}

// 在 setupNode 中会启动 qosContainerManager
func (cm *containerManagerImpl) setupNode(activePods ActivePodsFunc) error {
    f, err := validateSystemRequirements(cm.mountUtil)
    if err != nil {
        return err
    }
    if !f.cpuHardcapping {
        cm.status.SoftRequirements = fmt.Errorf("CPU hardcapping unsupported")
    }
    b := KernelTunableModify
    if cm.GetNodeConfig().ProtectKernelDefaults {
        b = KernelTunableError
    }
    // 1、检查依赖的内核参数是否配置正确
    if err := setupKernelTunables(b); err != nil {
        return err
    }

    if cm.NodeConfig.CgroupsPerQOS {
        // 2、创建 root cgroup，即 kubepods dir
        if err := cm.createNodeAllocatableCgroups(); err != nil {
            return err
        }
        // 3、启动 qosContainerManager
        err = cm.qosContainerManager.Start(cm.getNodeAllocatableAbsolute, activePods)
        if err != nil {
            return fmt.Errorf("failed to initialize top level QOS containers: %v", err)
        }
    }

    // 4、为 node 配置 cgroup 资源限制
    if err := cm.enforceNodeAllocatableCgroups(); err != nil {
        return err
    }
    if cm.ContainerRuntime == "docker" {
        cm.periodicTasks = append(cm.periodicTasks, func() {
            cont, err := getContainerNameForProcess(dockerProcessName, dockerPidFile)
            if err != nil {
                klog.Error(err)
                return
            }
            cm.Lock()
            defer cm.Unlock()
            cm.RuntimeCgroupsName = cont
        })
    }

    // 5、为系统组件配置对应的 cgroup 资源限制
    if cm.SystemCgroupsName != "" {
        if cm.SystemCgroupsName == "/" {
            return fmt.Errorf("system container cannot be root (\"/\")")
        }
        cont := newSystemCgroups(cm.SystemCgroupsName)
        cont.ensureStateFunc = func(manager *fs.Manager) error {
            return ensureSystemCgroups("/", manager)
        }
        systemContainers = append(systemContainers, cont)
    }

    // 6、为系统进程配置 oom_score_adj
    if cm.KubeletCgroupsName != "" {
        cont := newSystemCgroups(cm.KubeletCgroupsName)
        allowAllDevices := true
        manager := fs.Manager{
            Cgroups: &configs.Cgroup{
                Parent: "/",
                Name:   cm.KubeletCgroupsName,
                Resources: &configs.Resources{
                    AllowAllDevices: &allowAllDevices,
                },
            },
        }
        cont.ensureStateFunc = func(_ *fs.Manager) error {
            return ensureProcessInContainerWithOOMScore(os.Getpid(), qos.KubeletOOMScoreAdj, &manager)
        }
        systemContainers = append(systemContainers, cont)
    } else {
        cm.periodicTasks = append(cm.periodicTasks, func() {
            if err := ensureProcessInContainerWithOOMScore(os.Getpid(), qos.KubeletOOMScoreAdj, nil); err != nil {
                klog.Error(err)
                return
            }
            cont, err := getContainer(os.Getpid())
            if err != nil {
                klog.Errorf("failed to find cgroups of kubelet - %v", err)
                return
            }
            cm.Lock()
            defer cm.Unlock()

            cm.KubeletCgroupsName = cont
        })
    }
    cm.systemContainers = systemContainers
    return nil
}
```



##### cm.qosContainerManager.Start

`cm.qosContainerManager.Start` 主要逻辑为：
- 1、检查 root cgroup 是否存在，root cgroup 会在启动 `qosContainerManager` 之前创建；
- 2、为 `Burstable` 和 `BestEffort` 创建 Qos level cgroups 并设置默认值；
- 3、调用 `m.UpdateCgroups` 每分钟定期更新 cgroup 信息；



`k8s.io/kubernetes/pkg/kubelet/cm/qos_container_manager_linux.go:80`

```
func (m *qosContainerManagerImpl) Start(getNodeAllocatable func() v1.ResourceList, activePods ActivePodsFunc) error {
    cm := m.cgroupManager
    rootContainer := m.cgroupRoot

    // 1、检查 root cgroup 是否存在
    if !cm.Exists(rootContainer) {
        return fmt.Errorf("root container %v doesn't exist", rootContainer)
    }

    // 2、为 Qos 配置 Top level cgroups
    qosClasses := map[v1.PodQOSClass]CgroupName{
        v1.PodQOSBurstable:  NewCgroupName(rootContainer, strings.ToLower(string(v1.PodQOSBurstable))),
        v1.PodQOSBestEffort: NewCgroupName(rootContainer, strings.ToLower(string(v1.PodQOSBestEffort))),
    }

    // 3、为 Qos 创建 top level cgroups
    for qosClass, containerName := range qosClasses {
        resourceParameters := &ResourceConfig{}
        // 4、为 BestEffort QoS cpu.shares 设置默认值，默认为 2
        if qosClass == v1.PodQOSBestEffort {
            minShares := uint64(MinShares)
            resourceParameters.CpuShares = &minShares
        }

        containerConfig := &CgroupConfig{
            Name:               containerName,
            ResourceParameters: resourceParameters,
        }

        // 5、配置 huge page size
        m.setHugePagesUnbounded(containerConfig)

        // 6、为 Qos 创建 cgroup 目录
        if !cm.Exists(containerName) {
            if err := cm.Create(containerConfig); err != nil {
                ......
            }
        } else {
            if err := cm.Update(containerConfig); err != nil {
                ......
            }
        }
    }
    ......

    // 7、每分钟定期更新 cgroup 配置
    go wait.Until(func() {
        err := m.UpdateCgroups()
        if err != nil {
            klog.Warningf("[ContainerManager] Failed to reserve QoS requests: %v", err)
        }
    }, periodicQOSCgroupUpdateInterval, wait.NeverStop)

    return nil
}
```



##### m.UpdateCgroups

`m.UpdateCgroups`  是用来更新 Qos level cgroup 中的值，其主要逻辑为：
- 1、调用 `m.setCPUCgroupConfig` 计算 node 上的 activePods 的资源以此来更新 `bestEffort` 和 `burstable` Qos level cgroup 的 `cpu.shares` 值，`besteffort` 的 `cpu.shares` 值默认为 2，`burstable cpu.shares` 的计算方式为：max(sum(Burstable pods cpu requests）* 1024 /1000, 2)；
- 2、调用` m.setHugePagesConfig` 更新 huge pages；
- 3、检查是否启用了` --qos-reserved` 参数，若启用了则调用 `m.setMemoryReserve` 计算每个 Qos class 中需要设定的值然后调用 `m.cgroupManager.Update` 更新 cgroup 中的值；
- 4、最后调用 `m.cgroupManager.Update` 更新 cgroup 中的值；


`k8s.io/kubernetes/pkg/kubelet/cm/qos_container_manager_linux.go:269`

```
func (m *qosContainerManagerImpl) UpdateCgroups() error {
    m.Lock()
    defer m.Unlock()

    qosConfigs := map[v1.PodQOSClass]*CgroupConfig{
        v1.PodQOSBurstable: {
            Name:               m.qosContainersInfo.Burstable,
            ResourceParameters: &ResourceConfig{},
        },
        v1.PodQOSBestEffort: {
            Name:               m.qosContainersInfo.BestEffort,
            ResourceParameters: &ResourceConfig{},
        },
    }

    // 1、更新 bestEffort 和 burstable Qos level cgroup 的 cpu.shares 值
    if err := m.setCPUCgroupConfig(qosConfigs); err != nil {
        return err
    }

    // 2、调用 m.setHugePagesConfig 更新 huge pages
    if err := m.setHugePagesConfig(qosConfigs); err != nil {
        return err
    }

    // 3、设置资源预留
    if utilfeature.DefaultFeatureGate.Enabled(kubefeatures.QOSReserved) {
        for resource, percentReserve := range m.qosReserved {
            switch resource {
            case v1.ResourceMemory:
                m.setMemoryReserve(qosConfigs, percentReserve)
            }
        }

        updateSuccess := true
        for _, config := range qosConfigs {
            err := m.cgroupManager.Update(config)
            if err != nil {
                updateSuccess = false
            }
        }
        if updateSuccess {
            klog.V(4).Infof("[ContainerManager]: Updated QoS cgroup configuration")
            return nil
        }

        for resource, percentReserve := range m.qosReserved {
            switch resource {
            case v1.ResourceMemory:
                m.retrySetMemoryReserve(qosConfigs, percentReserve)
            }
        }
    }

    // 4、更新 cgroup 中的值
    for _, config := range qosConfigs {
        err := m.cgroupManager.Update(config)
        if err != nil {
            return err
        }
    }

    return nil
}
```



##### m.cgroupManager.Update

`m.cgroupManager.Update` 方法主要是根据 cgroup 配置来更新 cgroup 中的值，其主要逻辑为：
- 1、调用 `m.buildCgroupPaths` 创建对应的 cgroup 目录，在每个 cgroup 子系统下面都有一个 kubelet 对应的 root cgroup 目录；
- 2、调用  `setSupportedSubsystems` 更新的 cgroup 子系统中的值；



`k8s.io/kubernetes/pkg/kubelet/cm/cgroup_manager_linux.go:409`

```
func (m *cgroupManagerImpl) Update(cgroupConfig *CgroupConfig) error {
    ......
    resourceConfig := cgroupConfig.ResourceParameters
    resources := m.toResources(resourceConfig)

    cgroupPaths := m.buildCgroupPaths(cgroupConfig.Name)

    libcontainerCgroupConfig := &libcontainerconfigs.Cgroup{
        Resources: resources,
        Paths:     cgroupPaths,
    }

    if m.adapter.cgroupManagerType == libcontainerSystemd {
        updateSystemdCgroupInfo(libcontainerCgroupConfig, cgroupConfig.Name)
    } else {
        libcontainerCgroupConfig.Path = cgroupConfig.Name.ToCgroupfs()
    }

    if utilfeature.DefaultFeatureGate.Enabled(kubefeatures.SupportPodPidsLimit) && cgroupConfig.ResourceParameters != nil && cgroupConfig.               ResourceParameters.PidsLimit != nil {
        libcontainerCgroupConfig.PidsLimit = *cgroupConfig.ResourceParameters.PidsLimit
    }

    if err := setSupportedSubsystems(libcontainerCgroupConfig); err != nil {
        return fmt.Errorf("failed to set supported cgroup subsystems for cgroup %v: %v", cgroupConfig.Name, err)
    }
    return nil
}
```



###### setSupportedSubsystem

`setSupportedSubsystems` 首先通过 `getSupportedSubsystems` 获取 kubelet 支持哪些 cgroup 子系统，然后调用 `sys.Set` 设置对应子系统的值，`sys.Set` 是调用 `runc/libcontainer` 中的包进行设置的，其主要逻辑是在 cgroup 子系统对应的文件中写入值。

`k8s.io/kubernetes/pkg/kubelet/cm/cgroup_manager_linux.go:345`

```
func setSupportedSubsystems(cgroupConfig *libcontainerconfigs.Cgroup) error {
    for sys, required := range getSupportedSubsystems() {
        if _, ok := cgroupConfig.Paths[sys.Name()]; !ok {
            if required {
                return fmt.Errorf("failed to find subsystem mount for required subsystem: %v", sys.Name())
            }
            ......
            continue
        }
        if err := sys.Set(cgroupConfig.Paths[sys.Name()], cgroupConfig); err != nil {
            return fmt.Errorf("failed to set config for supported subsystems : %v", err)
        }
    }
    return nil
}
```

例如为 cgroup 中 cpu 子系统设置值的方法如下所示：

```
func (s *CpuGroup) Set(path string, cgroup *configs.Cgroup) error {
    if cgroup.Resources.CpuShares != 0 {
        if err := writeFile(path, "cpu.shares", strconv.FormatUint(cgroup.Resources.CpuShares, 10)); err != nil {
            return err
        }
    }
    if cgroup.Resources.CpuPeriod != 0 {
        if err := writeFile(path, "cpu.cfs_period_us", strconv.FormatUint(cgroup.Resources.CpuPeriod, 10)); err != nil {
            return err
        }
    }
    if cgroup.Resources.CpuQuota != 0 {
        if err := writeFile(path, "cpu.cfs_quota_us", strconv.FormatInt(cgroup.Resources.CpuQuota, 10)); err != nil {
            return err
        }
    }
    return s.SetRtSched(path, cgroup)
}
```



#### Pod Level Cgroup

Pod Level cgroup 是 kubelet 在创建 pod 时创建的，创建 pod 是在 kubelet 的 `syncPod` 方法中进行的，在 `syncPod` 方法中首先会调用 `kl.containerManager.UpdateQOSCgroups` 更新 Qos Level cgroup，然后调用 `pcm.EnsureExists` 创建 pod level cgroup。

```
func (kl *Kubelet) syncPod(o syncPodOptions) error {
        ......
        if !kl.podIsTerminated(pod) {
            ......
            if !(podKilled && pod.Spec.RestartPolicy == v1.RestartPolicyNever) {
                if !pcm.Exists(pod) {
                    if err := kl.containerManager.UpdateQOSCgroups(); err != nil {
                        ......
                    }
                    if err := pcm.EnsureExists(pod); err != nil {
                        ......
                    }
                }
            }
        }
        ......
}
```



`EnsureExists` 的主要逻辑是检查 pod 的 cgroup 是否存在，若不存在则调用 `m.cgroupManager.Create` 进行创建。

`k8s.io/kubernetes/pkg/kubelet/cm/pod_container_manager_linux.go:79`

```
func (m *podContainerManagerImpl) EnsureExists(pod *v1.Pod) error {
    podContainerName, _ := m.GetPodContainerName(pod)

    alreadyExists := m.Exists(pod)
    if !alreadyExists {
        containerConfig := &CgroupConfig{
            Name:               podContainerName,
            ResourceParameters: ResourceConfigForPod(pod, m.enforceCPULimits, m.cpuCFSQuotaPeriod),
        }
        if utilfeature.DefaultFeatureGate.Enabled(kubefeatures.SupportPodPidsLimit) && m.podPidsLimit > 0 {
            containerConfig.ResourceParameters.PidsLimit = &m.podPidsLimit
        }
        if err := m.cgroupManager.Create(containerConfig); err != nil {
            return fmt.Errorf("failed to create container for %v : %v", podContainerName, err)
        }
    }
    ......
    return nil
}
```



#### Container Level Cgroup

Container Level Cgroup 是通过 runtime 进行创建的，若使用 runc  其会调用 runc 的 `InitProcess.start`  方法对 cgroup 资源组进行配置与应用。



`k8s.io/kubernetes/vendor/github.com/opencontainers/runc/libcontainer/process_linux.go:282`

```
func (p *initProcess) start() error {
    ......

    // 调用 p.manager.Apply 为进程配置 cgroup
    if err := p.manager.Apply(p.pid()); err != nil {
        return newSystemErrorWithCause(err, "applying cgroup configuration for process")
    }
    if p.intelRdtManager != nil {
        if err := p.intelRdtManager.Apply(p.pid()); err != nil {
            return newSystemErrorWithCause(err, "applying Intel RDT configuration for process")
        }
    }
    ......
}
```





### 总结

kubernetes 中有三种 Qos，分别为 Guaranteed、Burstable、BestEffort，三种 Qos 以 node 上 allocatable 资源量为基于为 pod 进行分配，并通过多个 level cgroup 进行层层限制，对 cgroup 的配置都是通过调用 `runc/libcontainer/cgroups/fs` 中的方法进行资源更新的。对于 Qos level cgroup，kubelet 会根据以下事件动态更新：

- 1、kubelet 服务启动时；
- 2、在创建 pod level cgroup 之前，即创建 pod 前；
- 3、在删除 pod level cgroup 后；
- 4、定期检测是否需要为 qos level cgroup 预留资源；



参考：

https://kubernetes.io/docs/setup/production-environment/container-runtimes/#cgroup-drivers

https://zhuanlan.zhihu.com/p/38359775

https://github.com/kubernetes/community/blob/master/contributors/design-proposals/node/pod-resource-management.md

https://github.com/cri-o/cri-o/issues/842

https://yq.aliyun.com/articles/737784?spm=a2c4e.11153940.0.0.577f6149mYFkTR
