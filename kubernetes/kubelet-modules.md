---
title: kubelet 架构浅析
date: 2018-12-16 17:35:30
tags: "kubelet"
type: "kubelet"

---

## 一、概要
kubelet 是运行在每个节点上的主要的“节点代理”，每个节点都会启动 kubelet进程，用来处理 Master 节点下发到本节点的任务，按照 PodSpec 描述来管理Pod 和其中的容器（PodSpec 是用来描述一个 pod 的 YAML 或者 JSON 对象）。

kubelet 通过各种机制（主要通过 apiserver ）获取一组 PodSpec 并保证在这些 PodSpec 中描述的容器健康运行。

## 二、kubelet 的主要功能

1、kubelet  默认监听四个端口，分别为 10250 、10255、10248、4194。

```
LISTEN     0      128          *:10250                    *:*                   users:(("kubelet",pid=48500,fd=28))
LISTEN     0      128          *:10255                    *:*                   users:(("kubelet",pid=48500,fd=26))
LISTEN     0      128          *:4194                     *:*                   users:(("kubelet",pid=48500,fd=13))
LISTEN     0      128    127.0.0.1:10248                    *:*                   users:(("kubelet",pid=48500,fd=23))
```

- 10250（kubelet API）：kubelet server 与 apiserver 通信的端口，定期请求 apiserver 获取自己所应当处理的任务，通过该端口可以访问获取 node 资源以及状态。

- 10248（健康检查端口）：通过访问该端口可以判断 kubelet 是否正常工作, 通过 kubelet 的启动参数 `--healthz-port` 和 `--healthz-bind-address` 来指定监听的地址和端口。
```
  $ curl http://127.0.0.1:10248/healthz
  ok
```
- 4194（cAdvisor 监听）：kublet 通过该端口可以获取到该节点的环境信息以及 node 上运行的容器状态等内容，访问 http://localhost:4194 可以看到 cAdvisor 的管理界面,通过 kubelet 的启动参数 `--cadvisor-port` 可以指定启动的端口。

```
  $ curl  http://127.0.0.1:4194/metrics
```

- 10255 （readonly API）：提供了 pod 和 node 的信息，接口以只读形式暴露出去，访问该端口不需要认证和鉴权。
``` 
  //  获取 pod 的接口，与 apiserver 的 
  // http://127.0.0.1:8080/api/v1/pods?fieldSelector=spec.nodeName=  接口类似
  $ curl  http://127.0.0.1:10255/pods

  // 节点信息接口,提供磁盘、网络、CPU、内存等信息
  $ curl http://127.0.0.1:10255/spec/
```

2、kubelet 主要功能：

- pod 管理：kubelet 定期从所监听的数据源获取节点上 pod/container 的期望状态（运行什么容器、运行的副本数量、网络或者存储如何配置等等），并调用对应的容器平台接口达到这个状态。

- 容器健康检查：kubelet 创建了容器之后还要查看容器是否正常运行，如果容器运行出错，就要根据 pod 设置的重启策略进行处理。

- 容器监控：kubelet 会监控所在节点的资源使用情况，并定时向 master 报告，资源使用数据都是通过 cAdvisor 获取的。知道整个集群所有节点的资源情况，对于 pod 的调度和正常运行至关重要。


## 三、kubelet 组件中的模块

 ![kubelet 组件中的模块](http://cdn.tianfeiyu.com/kubelet-4.png)

上图展示了 kubelet 组件中的模块以及模块间的划分。

- 1、PLEG(Pod Lifecycle Event Generator）
PLEG 是 kubelet 的核心模块,PLEG 会一直调用 container runtime 获取本节点 containers/sandboxes 的信息，并与自身维护的 pods cache 信息进行对比，生成对应的 PodLifecycleEvent，然后输出到 eventChannel 中，通过 eventChannel 发送到 kubelet syncLoop 进行消费，然后由 kubelet syncPod 来触发 pod 同步处理过程，最终达到用户的期望状态。

- 2、cAdvisor 
cAdvisor（https://github.com/google/cadvisor）是 google 开发的容器监控工具，集成在 kubelet 中，起到收集本节点和容器的监控信息，大部分公司对容器的监控数据都是从 cAdvisor 中获取的 ，cAvisor 模块对外提供了 interface 接口，该接口也被 imageManager，OOMWatcher，containerManager 等所使用。

- 3、OOMWatcher 
系统 OOM 的监听器，会与 cadvisor 模块之间建立 SystemOOM,通过 Watch方式从 cadvisor 那里收到的 OOM 信号，并产生相关事件。

- 4、probeManager 
probeManager 依赖于 statusManager,livenessManager,containerRefManager，会定时去监控 pod 中容器的健康状况，当前支持两种类型的探针：livenessProbe 和readinessProbe。
livenessProbe：用于判断容器是否存活，如果探测失败，kubelet 会 kill 掉该容器，并根据容器的重启策略做相应的处理。
readinessProbe：用于判断容器是否启动完成，将探测成功的容器加入到该 pod 所在 service 的 endpoints 中，反之则移除。readinessProbe 和 livenessProbe 有三种实现方式：http、tcp 以及 cmd。 

- 5、statusManager 
statusManager 负责维护状态信息，并把 pod 状态更新到 apiserver，但是它并不负责监控 pod 状态的变化，而是提供对应的接口供其他组件调用，比如 probeManager。

- 6、containerRefManager
容器引用的管理，相对简单的Manager，用来报告容器的创建，失败等事件，通过定义 map 来实现了 containerID 与 v1.ObjectReferece 容器引用的映射。

- 7、evictionManager 
当节点的内存、磁盘或 inode 等资源不足时，达到了配置的 evict 策略， node 会变为 pressure 状态，此时 kubelet 会按照 qosClass 顺序来驱赶 pod，以此来保证节点的稳定性。可以通过配置 kubelet 启动参数 `--eviction-hard=` 来决定 evict 的策略值。

- 8、imageGC 
imageGC 负责 node 节点的镜像回收，当本地的存放镜像的本地磁盘空间达到某阈值的时候，会触发镜像的回收，删除掉不被 pod 所使用的镜像，回收镜像的阈值可以通过 kubelet 的启动参数 `--image-gc-high-threshold` 和 `--image-gc-low-threshold` 来设置。

- 9、containerGC 
containerGC 负责清理 node 节点上已消亡的 container，具体的 GC 操作由runtime 来实现。

- 10、imageManager 
调用 kubecontainer 提供的PullImage/GetImageRef/ListImages/RemoveImage/ImageStates 方法来保证pod 运行所需要的镜像。

- 11、volumeManager 
负责 node 节点上 pod 所使用 volume 的管理，volume 与 pod 的生命周期关联，负责 pod 创建删除过程中 volume 的 mount/umount/attach/detach 流程，kubernetes 采用 volume Plugins 的方式，实现存储卷的挂载等操作，内置几十种存储插件。

- 12、containerManager 
负责 node 节点上运行的容器的 cgroup 配置信息，kubelet 启动参数如果指定 `--cgroups-per-qos` 的时候，kubelet 会启动 goroutine 来周期性的更新 pod 的 cgroup 信息，维护其正确性，该参数默认为 `true`，实现了 pod 的Guaranteed/BestEffort/Burstable 三种级别的 Qos。

- 13、runtimeManager 
containerRuntime 负责 kubelet 与不同的 runtime 实现进行对接，实现对于底层 container 的操作，初始化之后得到的 runtime 实例将会被之前描述的组件所使用。可以通过 kubelet 的启动参数 `--container-runtime` 来定义是使用docker 还是 rkt，默认是 `docker`。

- 14、podManager 
podManager 提供了接口来存储和访问 pod 的信息，维持 static pod 和 mirror pods 的关系，podManager 会被statusManager/volumeManager/runtimeManager 所调用，podManager 的接口处理流程里面会调用 secretManager 以及 configMapManager。 


在 v1.12 中，kubelet 组件有18个 manager：

```
certificateManager
cgroupManager
containerManager
cpuManager
nodeContainerManager
configmapManager
containerReferenceManager
evictionManager
nvidiaGpuManager
imageGCManager
kuberuntimeManager
hostportManager
podManager
proberManager
secretManager
statusManager
volumeManager	
tokenManager
```

其中比较重要的模块后面会进行一一分析。


参考：
[微软资深工程师详解 K8S 容器运行时](https://juejin.im/entry/5bc71b3d6fb9a05cf23029b8)
[kubernetes 简介： kubelet 和 pod](https://cizixs.com/2016/10/25/kubernetes-intro-kubelet/)
[Kubelet 组件解析](https://blog.csdn.net/jettery/article/details/78891733)



