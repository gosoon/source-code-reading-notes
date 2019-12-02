---
title: kubelet 启动流程分析
date: 2018-12-23 21:22:30
tags: "kubelet"
type: "kubelet"

---

上篇文章（[kubelet 架构浅析](https://blog.tianfeiyu.com/2018/12/16/kubelet-modules/) ）已经介绍过 kubelet 在整个集群架构中的功能以及自身各模块的用途，本篇文章主要介绍 kubelet 的启动流程。

 > kubernetes 版本： v1.12 


## kubelet 启动流程

kubelet 代码结构:

```
➜  kubernetes git:(release-1.12) ✗ tree cmd/kubelet
cmd/kubelet
├── BUILD
├── OWNERS
├── app
│   ├── BUILD
│   ├── OWNERS
│   ├── auth.go
│   ├── init_others.go
│   ├── init_windows.go
│   ├── options
│   │   ├── BUILD
│   │   ├── container_runtime.go
│   │   ├── globalflags.go
│   │   ├── globalflags_linux.go
│   │   ├── globalflags_other.go
│   │   ├── options.go
│   │   ├── options_test.go
│   │   ├── osflags_others.go
│   │   └── osflags_windows.go
│   ├── plugins.go
│   ├── server.go
│   ├── server_linux.go
│   ├── server_test.go
│   └── server_unsupported.go
└── kubelet.go

2 directories, 22 files
```

![kubelet 启动流程时序图](http://cdn.tianfeiyu.com/kubelet-3.png)

#### 1、kubelet 入口函数 main（cmd/kubelet/kubelet.go）

```
func main() {
	rand.Seed(time.Now().UTC().UnixNano())

	command := app.NewKubeletCommand(server.SetupSignalHandler())
	logs.InitLogs()
	defer logs.FlushLogs()

	if err := command.Execute(); err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		os.Exit(1)
	}
}
```

#### 2、初始化 kubelet 配置（cmd/kubelet/app/server.go）

NewKubeletCommand() 函数主要负责获取配置文件中的参数，校验参数以及为参数设置默认值。  

```
// NewKubeletCommand creates a *cobra.Command object with default parameters
func NewKubeletCommand(stopCh <-chan struct{}) *cobra.Command {
    cleanFlagSet := pflag.NewFlagSet(componentKubelet, pflag.ContinueOnError)
    cleanFlagSet.SetNormalizeFunc(flag.WordSepNormalizeFunc)
    // Kubelet配置分两部分:
    // KubeletFlag: 指那些不允许在 kubelet 运行时进行修改的配置集，或者不能在集群中各个 Nodes 之间共享的配置集。
    // KubeletConfiguration: 指可以在集群中各个Nodes之间共享的配置集，可以进行动态配置。
    kubeletFlags := options.NewKubeletFlags()
	kubeletConfig, err := options.NewKubeletConfiguration()
	...
	cmd := &cobra.Command{
		...
		Run: func(cmd *cobra.Command, args []string) {
			// 读取 kubelet 配置文件
			if configFile := kubeletFlags.KubeletConfigFile; len(configFile) > 0 {
				kubeletConfig, err = loadConfigFile(configFile)
				if err != nil {
					glog.Fatal(err)
				}
				...
			}
			// 校验 kubelet 参数
			if err := kubeletconfigvalidation.ValidateKubeletConfiguration(kubeletConfig); err != nil {
				glog.Fatal(err)
			}
			...
			// 此处初始化了 kubeletDeps
			kubeletDeps, err := UnsecuredDependencies(kubeletServer)
			if err != nil {
				glog.Fatal(err)
			}
			...
			// 启动程序
			if err := Run(kubeletServer, kubeletDeps, stopCh); err != nil {
				glog.Fatal(err)
			}
		},
	}
    ...
	return cmd
}
```
kubeletDeps 包含 kubelet 运行所必须的配置，是为了实现 dependency injection，其目的是为了把 kubelet 依赖的组件对象作为参数传进来，这样可以控制 kubelet 的行为。主要包括监控功能（cadvisor），cgroup 管理功能（containerManager）等。

NewKubeletCommand() 会调用 Run() 函数，Run() 中主要调用 run() 函数进行一些准备事项。

#### 3、创建和 apiserver 通信的对象（cmd/kubelet/app/server.go）

run() 函数的主要功能：

- 1、创建 kubeClient，evnetClient 用来和 apiserver 通信。创建 heartbeatClient 向 apiserver 上报心跳状态。
- 2、为 kubeDeps 设定一些默认值。
- 3、启动监听 Healthz 端口的 http server，默认端口是 10248。

```
func run(s *options.KubeletServer, kubeDeps *kubelet.Dependencies, stopCh <-chan struct{}) (err error) {
	...
	// 判断 kubelet 的启动模式
	if standaloneMode {
	...
	} else if kubeDeps.KubeClient == nil || kubeDeps.EventClient == nil || kubeDeps.HeartbeatClient == nil || kubeDeps.DynamicKubeClient == nil {
		...
		// 创建对象 kubeClient
		kubeClient, err = clientset.NewForConfig(clientConfig)

		...
        // 创建对象 evnetClient
		eventClient, err = v1core.NewForConfig(&eventClientConfig)
		...
		// heartbeatClient 上报状态
		heartbeatClient, err = clientset.NewForConfig(&heartbeatClientConfig)
		...
	}

	// 为 kubeDeps 设定一些默认值
	if kubeDeps.Auth == nil {
			auth, err := BuildAuth(nodeName, kubeDeps.KubeClient, s.KubeletConfiguration)
			if err != nil {
				return err
			}
			kubeDeps.Auth = auth
		}

		if kubeDeps.CAdvisorInterface == nil {
			imageFsInfoProvider := cadvisor.NewImageFsInfoProvider(s.ContainerRuntime, s.RemoteRuntimeEndpoint)
			kubeDeps.CAdvisorInterface, err = cadvisor.New(imageFsInfoProvider, s.RootDirectory, cadvisor.UsingLegacyCadvisorStats(s.ContainerRuntime, s.RemoteRuntimeEndpoint))
			if err != nil {
				return err
			}
		}
	}

	// 
	if err := RunKubelet(s, kubeDeps, s.RunOnce); err != nil {
			return err
	}
	...
	// 启动监听 Healthz 端口的 http server  
	if s.HealthzPort > 0 {
		healthz.DefaultHealthz()
		go wait.Until(func() {
			err := http.ListenAndServe(net.JoinHostPort(s.HealthzBindAddress, strconv.Itoa(int(s.HealthzPort))), nil)
			if err != nil {
				glog.Errorf("Starting health server failed: %v", err)
			}
		}, 5*time.Second, wait.NeverStop)
	}
	...
}
```
kubelet 对 pod 资源的获取方式有三种：第一种是通过文件获得，文件一般放在 /etc/kubernetes/manifests 目录下面；第二种也是通过文件过得，只不过文件是通过 URL 获取的；第三种是通过 watch kube-apiserver 获取。其中前两种模式下，我们称 kubelet 运行在 standalone 模式下，运行在 standalone 模式下的 kubelet 一般用于调试某些功能。

run() 中调用 RunKubelet() 函数进行后续操作。

#### 4、初始化 kubelet 组件内部的模块（cmd/kubelet/app/server.go）

RunKubelet()  主要功能：

- 1、初始化 kubelet 组件中的各个模块，创建出 kubelet 对象。
- 2、启动垃圾回收服务。

```
func RunKubelet(kubeServer *options.KubeletServer, kubeDeps *kubelet.Dependencies, runOnce bool) error {
    ...

 	// 初始化 kubelet 内部模块
	k, err := CreateAndInitKubelet(&kubeServer.KubeletConfiguration,
		kubeDeps,
		&kubeServer.ContainerRuntimeOptions,
		kubeServer.ContainerRuntime,
		kubeServer.RuntimeCgroups,
		kubeServer.HostnameOverride,
		kubeServer.NodeIP,
		kubeServer.ProviderID,
		kubeServer.CloudProvider,
		kubeServer.CertDirectory,
		kubeServer.RootDirectory,
		kubeServer.RegisterNode,
		kubeServer.RegisterWithTaints,
		kubeServer.AllowedUnsafeSysctls,
		kubeServer.RemoteRuntimeEndpoint,
		kubeServer.RemoteImageEndpoint,
		kubeServer.ExperimentalMounterPath,
		kubeServer.ExperimentalKernelMemcgNotification,
		kubeServer.ExperimentalCheckNodeCapabilitiesBeforeMount,
		kubeServer.ExperimentalNodeAllocatableIgnoreEvictionThreshold,
		kubeServer.MinimumGCAge,
		kubeServer.MaxPerPodContainerCount,
		kubeServer.MaxContainerCount,
		kubeServer.MasterServiceNamespace,
		kubeServer.RegisterSchedulable,
		kubeServer.NonMasqueradeCIDR,
		kubeServer.KeepTerminatedPodVolumes,
		kubeServer.NodeLabels,
		kubeServer.SeccompProfileRoot,
		kubeServer.BootstrapCheckpointPath,
		kubeServer.NodeStatusMaxImages)
	if err != nil {
		return fmt.Errorf("failed to create kubelet: %v", err)
	}

	...
	if runOnce {
		if _, err := k.RunOnce(podCfg.Updates()); err != nil {
			return fmt.Errorf("runonce failed: %v", err)
		}
		glog.Infof("Started kubelet as runonce")
	} else {
        // 
		startKubelet(k, podCfg, &kubeServer.KubeletConfiguration, kubeDeps, kubeServer.EnableServer)
		glog.Infof("Started kubelet")
	}

}
```


```
func CreateAndInitKubelet(...){
	// NewMainKubelet 实例化一个 kubelet 对象，并对 kubelet 内部各个模块进行初始化
	k, err = kubelet.NewMainKubelet(kubeCfg,
		kubeDeps,
		crOptions,
		containerRuntime,
		runtimeCgroups,
		hostnameOverride,
		nodeIP,
		providerID,
		cloudProvider,
		certDirectory,
		rootDirectory,
		registerNode,
		registerWithTaints,
		allowedUnsafeSysctls,
		remoteRuntimeEndpoint,
		remoteImageEndpoint,
		experimentalMounterPath,
		experimentalKernelMemcgNotification,
		experimentalCheckNodeCapabilitiesBeforeMount,
		experimentalNodeAllocatableIgnoreEvictionThreshold,
		minimumGCAge,
		maxPerPodContainerCount,
		maxContainerCount,
		masterServiceNamespace,
		registerSchedulable,
		nonMasqueradeCIDR,
		keepTerminatedPodVolumes,
		nodeLabels,
		seccompProfileRoot,
		bootstrapCheckpointPath,
		nodeStatusMaxImages)
	if err != nil {
		return nil, err
	}

	// 通知 apiserver kubelet 启动了
	k.BirthCry()
	// 启动垃圾回收服务
	k.StartGarbageCollection()

	return k, nil

}
```

```
func NewMainKubelet(kubeCfg *kubeletconfiginternal.KubeletConfiguration,...){
    ...
	if kubeDeps.PodConfig == nil {
		var err error
		// 初始化 makePodSourceConfig，监听 pod 元数据的来源(FILE, URL, api-server)，将不同 source 的 pod configuration 合并到一个结构中
		kubeDeps.PodConfig, err = makePodSourceConfig(kubeCfg, kubeDeps, nodeName, bootstrapCheckpointPath)
		if err != nil {
			return nil, err
		}
	}
    
    // kubelet 服务端口，默认 10250
	daemonEndpoints := &v1.NodeDaemonEndpoints{
		KubeletEndpoint: v1.DaemonEndpoint{Port: kubeCfg.Port},
	}

	// 使用 reflector 把 ListWatch 得到的服务信息实时同步到 serviceStore 对象中
	serviceIndexer := cache.NewIndexer(cache.MetaNamespaceKeyFunc, cache.Indexers{cache.NamespaceIndex: cache.MetaNamespaceIndexFunc})
	if kubeDeps.KubeClient != nil {
		serviceLW := cache.NewListWatchFromClient(kubeDeps.KubeClient.CoreV1().RESTClient(), "services", metav1.NamespaceAll, fields.Everything())
		r := cache.NewReflector(serviceLW, &v1.Service{}, serviceIndexer, 0)
		go r.Run(wait.NeverStop)
	}
	serviceLister := corelisters.NewServiceLister(serviceIndexer)

	// 使用 reflector 把 ListWatch 得到的节点信息实时同步到  nodeStore 对象中
	nodeIndexer := cache.NewIndexer(cache.MetaNamespaceKeyFunc, cache.Indexers{})
	if kubeDeps.KubeClient != nil {
		fieldSelector := fields.Set{api.ObjectNameField: string(nodeName)}.AsSelector()
		nodeLW := cache.NewListWatchFromClient(kubeDeps.KubeClient.CoreV1().RESTClient(), "nodes", metav1.NamespaceAll, fieldSelector)
		r := cache.NewReflector(nodeLW, &v1.Node{}, nodeIndexer, 0)
		go r.Run(wait.NeverStop)
	}
	nodeInfo := &predicates.CachedNodeInfo{NodeLister: corelisters.NewNodeLister(nodeIndexer)}

	...
	// node 资源不足时的驱逐策略的设定
	thresholds, err := eviction.ParseThresholdConfig(enforceNodeAllocatable, kubeCfg.EvictionHard, kubeCfg.EvictionSoft, kubeCfg.EvictionSoftGracePeriod, kubeCfg.EvictionMinimumReclaim)
	if err != nil {
		return nil, err
	}
	evictionConfig := eviction.Config{
		PressureTransitionPeriod: kubeCfg.EvictionPressureTransitionPeriod.Duration,
		MaxPodGracePeriodSeconds: int64(kubeCfg.EvictionMaxPodGracePeriod),
		Thresholds:               thresholds,
		KernelMemcgNotification:  experimentalKernelMemcgNotification,
		PodCgroupRoot:            kubeDeps.ContainerManager.GetPodCgroupRoot(),
	}
    ...
    // 容器引用的管理
	containerRefManager := kubecontainer.NewRefManager()
    // oom 监控
	oomWatcher := NewOOMWatcher(kubeDeps.CAdvisorInterface, kubeDeps.Recorder)

	// 根据配置信息和各种对象创建 Kubelet 实例
	klet := &Kubelet{
		hostname:                       hostname,
		hostnameOverridden:             len(hostnameOverride) > 0,
		nodeName:                       nodeName,
		...
	}
	
	// 从 cAdvisor 获取当前机器的信息
	machineInfo, err := klet.cadvisor.MachineInfo()

	// 对 pod 的管理（如: 增删改等）
	klet.podManager = kubepod.NewBasicPodManager(kubepod.NewBasicMirrorClient(klet.kubeClient), secretManager, configMapManager, checkpointManager)

	// 容器运行时管理
	runtime, err := kuberuntime.NewKubeGenericRuntimeManager(...)

	// pleg
	klet.pleg = pleg.NewGenericPLEG(klet.containerRuntime, plegChannelCapacity, plegRelistPeriod, klet.podCache, clock.RealClock{})

	// 创建 containerGC 对象，进行周期性的容器清理工作
	containerGC, err := kubecontainer.NewContainerGC(klet.containerRuntime, containerGCPolicy, klet.sourcesReady)

	// 创建 imageManager 管理镜像
	imageManager, err := images.NewImageGCManager(klet.containerRuntime, klet.StatsProvider, kubeDeps.Recorder, nodeRef, imageGCPolicy, crOptions.PodSandboxImage)
	
	// statusManager 实时检测节点上 pod 的状态，并更新到 apiserver 对应的 pod
	klet.statusManager = status.NewManager(klet.kubeClient, klet.podManager, klet)

	// 探针管理
	klet.probeManager = prober.NewManager(...)

    // token 管理
	tokenManager := token.NewManager(kubeDeps.KubeClient)

	// 磁盘管理
	klet.volumeManager = volumemanager.NewVolumeManager()
	
	// 将 syncPod() 注入到 podWorkers 中
	klet.podWorkers = newPodWorkers(klet.syncPod, kubeDeps.Recorder, klet.workQueue, klet.resyncInterval, backOffPeriod, klet.podCache)

	// 容器驱逐策略管理
	evictionManager, evictionAdmitHandler := eviction.NewManager(klet.resourceAnalyzer, evictionConfig, killPodNow(klet.podWorkers, kubeDeps.Recorder), klet.imageManager, klet.containerGC, kubeDeps.Recorder, nodeRef, klet.clock)
    ...
}
```
RunKubelet 最后会调用 startKubelet() 进行后续的操作。

#### 5、启动 kubelet 内部的模块及服务（cmd/kubelet/app/server.go）
startKubelet()  的主要功能：

- 1、以 goroutine 方式启动 kubelet 中的各个模块。
- 2、启动 kubelet http server。


```
func startKubelet(k kubelet.Bootstrap, podCfg *config.PodConfig, kubeCfg *kubeletconfiginternal.KubeletConfiguration, kubeDeps *kubelet.Dependencies, enableServer bool) {
	go wait.Until(func() {
		// 以 goroutine 方式启动 kubelet 中的各个模块
		k.Run(podCfg.Updates())
	}, 0, wait.NeverStop)

	// 启动 kubelet http server	
	if enableServer {
		go k.ListenAndServe(net.ParseIP(kubeCfg.Address), uint(kubeCfg.Port), kubeDeps.TLSOptions, kubeDeps.Auth, kubeCfg.EnableDebuggingHandlers, kubeCfg.EnableContentionProfiling)

	}
	if kubeCfg.ReadOnlyPort > 0 {
		go k.ListenAndServeReadOnly(net.ParseIP(kubeCfg.Address), uint(kubeCfg.ReadOnlyPort))
	}
}
```

```
// Run starts the kubelet reacting to config updates
func (kl *Kubelet) Run(updates <-chan kubetypes.PodUpdate) {
	if kl.logServer == nil {
		kl.logServer = http.StripPrefix("/logs/", http.FileServer(http.Dir("/var/log/")))
	}
	if kl.kubeClient == nil {
		glog.Warning("No api server defined - no node status update will be sent.")
	}

	// Start the cloud provider sync manager
	if kl.cloudResourceSyncManager != nil {
		go kl.cloudResourceSyncManager.Run(wait.NeverStop)
	}

	if err := kl.initializeModules(); err != nil {
		kl.recorder.Eventf(kl.nodeRef, v1.EventTypeWarning, events.KubeletSetupFailed, err.Error())
		glog.Fatal(err)
	}

	// Start volume manager
	go kl.volumeManager.Run(kl.sourcesReady, wait.NeverStop)

	if kl.kubeClient != nil {
		// Start syncing node status immediately, this may set up things the runtime needs to run.
		go wait.Until(kl.syncNodeStatus, kl.nodeStatusUpdateFrequency, wait.NeverStop)
		go kl.fastStatusUpdateOnce()

		// start syncing lease
		if utilfeature.DefaultFeatureGate.Enabled(features.NodeLease) {
			go kl.nodeLeaseController.Run(wait.NeverStop)
		}
	}
	go wait.Until(kl.updateRuntimeUp, 5*time.Second, wait.NeverStop)

	// Start loop to sync iptables util rules
	if kl.makeIPTablesUtilChains {
		go wait.Until(kl.syncNetworkUtil, 1*time.Minute, wait.NeverStop)
	}

	// Start a goroutine responsible for killing pods (that are not properly
	// handled by pod workers).
	go wait.Until(kl.podKiller, 1*time.Second, wait.NeverStop)

	// Start component sync loops.
	kl.statusManager.Start()
	kl.probeManager.Start()

	// Start syncing RuntimeClasses if enabled.
	if kl.runtimeClassManager != nil {
		go kl.runtimeClassManager.Run(wait.NeverStop)
	}

	// Start the pod lifecycle event generator.
	kl.pleg.Start()

	kl.syncLoop(updates, kl)
}
```
syncLoop 是 kubelet 的主循环方法，它从不同的管道(FILE,URL, API-SERVER)监听 pod 的变化，并把它们汇聚起来。当有新的变化发生时，它会调用对应的函数，保证 Pod 处于期望的状态。


```
func (kl *Kubelet) syncLoop(updates <-chan kubetypes.PodUpdate, handler SyncHandler) {
	glog.Info("Starting kubelet main sync loop.")

	// syncTicker 每秒检测一次是否有需要同步的 pod workers
	syncTicker := time.NewTicker(time.Second)
	defer syncTicker.Stop()
	housekeepingTicker := time.NewTicker(housekeepingPeriod)
	defer housekeepingTicker.Stop()
	plegCh := kl.pleg.Watch()
	const (
		base   = 100 * time.Millisecond
		max    = 5 * time.Second
		factor = 2
	)
	duration := base
	for {
		if rs := kl.runtimeState.runtimeErrors(); len(rs) != 0 {
			glog.Infof("skipping pod synchronization - %v", rs)
			// exponential backoff
			time.Sleep(duration)
			duration = time.Duration(math.Min(float64(max), factor*float64(duration)))
			continue
		}
		// reset backoff if we have a success
		duration = base

		kl.syncLoopMonitor.Store(kl.clock.Now())
		// 
		if !kl.syncLoopIteration(updates, handler, syncTicker.C, housekeepingTicker.C, plegCh) {
			break
		}
		kl.syncLoopMonitor.Store(kl.clock.Now())
	}
}
```

syncLoopIteration()  方法对多个管道进行遍历，如果 pod 发生变化，则会调用相应的 Handler，在 Handler 中通过调用 dispatchWork 分发任务。


## 总结

本篇文章主要讲述了 kubelet 组件从加载配置到初始化内部的各个模块再到启动 kubelet 服务的整个流程，上面的时序图能清楚的看到函数之间的调用关系，但是其中每个组件具体的工作方式以及组件之间的交互方式还不得而知，后面会一探究竟。

参考：
[kubernetes node components – kubelet](http://www.sel.zju.edu.cn/?p=595)
[Kubelet 源码分析(一):启动流程分析](https://segmentfault.com/a/1190000008267351)
[kubelet 源码分析：启动流程](https://cizixs.com/2017/06/06/kubelet-source-code-analysis-part-1/)
[kubernetes 的 kubelet 的工作过程](https://www.lijiaocn.com/%E9%A1%B9%E7%9B%AE/2017/05/02/Kubernetes-kubelet.html)
[kubelet 内部实现解析](https://fatsheep9146.github.io/2018/07/08/kubelet%E5%86%85%E9%83%A8%E5%AE%9E%E7%8E%B0%E8%A7%A3%E6%9E%90/)
