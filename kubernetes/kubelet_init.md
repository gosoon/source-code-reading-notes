---
title: kubelet 启动流程分析
date: 2020-1-3 20:22:30
tags: "kubelet"
type: "kubelet"

---

* [Kubelet 启动流程](#kubelet-启动流程)
   * [NewKubeletCommand](#newkubeletcommand)
   * [Run](#run)
   * [run](#run-1)
   * [RunKubelet](#runkubelet)
   * [createAndInitKubelet](#createandinitkubelet)
      * [kubelet.NewMainKubelet](#kubeletnewmainkubelet)
   * [startKubelet](#startkubelet)
* [Run](#run-2)
   * [initializeModules](#initializemodules)
   * [fastStatusUpdateOnce](#faststatusupdateonce)
      * [updateRuntimeUp](#updateruntimeup)
         * [initializeRuntimeDependentModules](#initializeruntimedependentmodules)
   * [小结](#小结)
   * [syncLoop](#syncloop)
      * [syncLoopIteration](#syncloopiteration)
* [总结](#总结)




本来这篇文章会继续讲述 kubelet 中的主要模块，但由于网友反馈能不能先从 kubelet 的启动流程开始，kubelet 的启动流程在很久之前基于 v1.12 写过一篇文章，对比了 v1.16 中的启动流程变化不大，但之前的文章写的比较简洁，本文会重新分析 kubelet 的启动流程。



### Kubelet 启动流程

> kubernetes 版本：v1.16



kubelet 的启动比较复杂，首先还是把 kubelet 的启动流程图放在此处，便于在后文中清楚各种调用的流程：

![](http://cdn.tianfeiyu.com/kubelet-3.png)



#### NewKubeletCommand

首先从 kubelet 的 `main` 函数开始，其中调用的 `NewKubeletCommand` 方法主要负责获取配置文件中的参数，校验参数以及为参数设置默认值。主要逻辑为：

- 1、解析命令行参数；
- 2、为 kubelet 初始化 feature gates 参数；
- 3、加载 kubelet 配置文件；
- 4、校验配置文件中的参数；
- 5、检查 kubelet 是否启用动态配置功能；
- 6、初始化 kubeletDeps，kubeletDeps 包含 kubelet 运行所必须的配置，是为了实现 dependency injection，其目的是为了把 kubelet 依赖的组件对象作为参数传进来，这样可以控制 kubelet 的行为；
- 7、调用 `Run` 方法；



`k8s.io/kubernetes/cmd/kubelet/app/server.go:111`

```
func NewKubeletCommand() *cobra.Command {
    cleanFlagSet := pflag.NewFlagSet(componentKubelet, pflag.ContinueOnError)
    cleanFlagSet.SetNormalizeFunc(cliflag.WordSepNormalizeFunc)
    
    // 1、kubelet配置分两部分:
    // KubeletFlag: 指那些不允许在 kubelet 运行时进行修改的配置集，或者不能在集群中各个 Nodes 之间共享的配置集。
    // KubeletConfiguration: 指可以在集群中各个Nodes之间共享的配置集，可以进行动态配置。
    kubeletFlags := options.NewKubeletFlags()
    kubeletConfig, err := options.NewKubeletConfiguration()
    if err != nil {
        klog.Fatal(err)
    }

    cmd := &cobra.Command{
        Use: componentKubelet,
        DisableFlagParsing: true,
        ......
        Run: func(cmd *cobra.Command, args []string) {
            // 2、解析命令行参数
            if err := cleanFlagSet.Parse(args); err != nil {
                cmd.Usage()
                klog.Fatal(err)
            }
            ......
					
            verflag.PrintAndExitIfRequested()
            utilflag.PrintFlags(cleanFlagSet)
           
            // 3、初始化 feature gates 配置
            if err := utilfeature.DefaultMutableFeatureGate.SetFromMap(kubeletConfig.FeatureGates); err != nil {
                klog.Fatal(err)
            }

            if err := options.ValidateKubeletFlags(kubeletFlags); err != nil {
                klog.Fatal(err)
            }

            if kubeletFlags.ContainerRuntime == "remote" && cleanFlagSet.Changed("pod-infra-container-image") {
                klog.Warning("Warning: For remote container runtime, --pod-infra-container-image is ignored in kubelet, which should be set in that      remote runtime instead")
            }

            // 4、加载 kubelet 配置文件
            if configFile := kubeletFlags.KubeletConfigFile; len(configFile) > 0 {
                kubeletConfig, err = loadConfigFile(configFile)
                ......
            }
            // 5、校验配置文件中的参数
            if err := kubeletconfigvalidation.ValidateKubeletConfiguration(kubeletConfig); err != nil {
                klog.Fatal(err)
            }

            // 6、检查 kubelet 是否启用动态配置功能
            var kubeletConfigController *dynamickubeletconfig.Controller
            if dynamicConfigDir := kubeletFlags.DynamicConfigDir.Value(); len(dynamicConfigDir) > 0 {
                var dynamicKubeletConfig *kubeletconfiginternal.KubeletConfiguration
                dynamicKubeletConfig, kubeletConfigController, err = BootstrapKubeletConfigController(dynamicConfigDir,
                    func(kc *kubeletconfiginternal.KubeletConfiguration) error {
                        return kubeletConfigFlagPrecedence(kc, args)
                    })
                if err != nil {
                    klog.Fatal(err)
                }
                if dynamicKubeletConfig != nil {
                    kubeletConfig = dynamicKubeletConfig
                    if err := utilfeature.DefaultMutableFeatureGate.SetFromMap(kubeletConfig.FeatureGates); err != nil {
                        klog.Fatal(err)
                    }
                }
            }
            kubeletServer := &options.KubeletServer{
                KubeletFlags:         *kubeletFlags,
                KubeletConfiguration: *kubeletConfig,
            }
            // 7、初始化 kubeletDeps
            kubeletDeps, err := UnsecuredDependencies(kubeletServer)
            if err != nil {
                klog.Fatal(err)
            }

            kubeletDeps.KubeletConfigController = kubeletConfigController
            stopCh := genericapiserver.SetupSignalHandler()
            if kubeletServer.KubeletFlags.ExperimentalDockershim {
                if err := RunDockershim(&kubeletServer.KubeletFlags, kubeletConfig, stopCh); err != nil {
                    klog.Fatal(err)
                }
                return
            }

            // 8、调用 Run 方法
            if err := Run(kubeletServer, kubeletDeps, stopCh); err != nil {
                klog.Fatal(err)
            }
        },
    }
    kubeletFlags.AddFlags(cleanFlagSet)
    options.AddKubeletConfigFlags(cleanFlagSet, kubeletConfig)
    options.AddGlobalFlags(cleanFlagSet)
    ......

    return cmd
}
```



#### Run

该方法中仅仅调用 `run` 方法执行后面的启动逻辑。



`k8s.io/kubernetes/cmd/kubelet/app/server.go:408`

```
func Run(s *options.KubeletServer, kubeDeps *kubelet.Dependencies, stopCh <-chan struct{}) error {
    if err := initForOS(s.KubeletFlags.WindowsService); err != nil {
        return fmt.Errorf("failed OS init: %v", err)
    }
    if err := run(s, kubeDeps, stopCh); err != nil {
        return fmt.Errorf("failed to run Kubelet: %v", err)
    }
    return nil
}
```



#### run

`run` 方法中主要是为 kubelet 的启动做一些基本的配置及检查工作，主要逻辑为：
- 1、为 kubelet 设置默认的 FeatureGates，kubelet 所有的 FeatureGates 可以通过命令参数查看，k8s 中处于 `Alpha` 状态的 FeatureGates 在组件启动时默认关闭，处于 `Beta` 和 GA 状态的默认开启；
- 2、校验 kubelet 的参数；
- 3、尝试获取 kubelet 的 `lock file`，需要在 kubelet 启动时指定 `--exit-on-lock-contention` 和 `--lock-file`，该功能处于 `Alpha` 版本默认为关闭状态；
- 4、将当前的配置文件注册到 http server `/configz` URL 中；
- 5、检查 kubelet 启动模式是否为 standalone 模式，此模式下不会和 apiserver 交互，主要用于 kubelet 的调试；
- 6、初始化 kubeDeps，kubeDeps 中包含 kubelet 的一些依赖，主要有 `KubeClient`、`EventClient`、`HeartbeatClient`、`Auth`、`cadvisor`、`ContainerManager`；
- 7、检查是否以 root 用户启动；
- 8、为进程设置 oom 分数，默认为 -999，分数范围为  [-1000, 1000]，越小越不容易被 kill 掉；
- 9、调用 `RunKubelet` 方法；
- 10、检查 kubelet 是否启动了动态配置功能；
- 11、启动 Healthz http server；
- 12、如果使用 systemd 启动，通知 systemd kubelet 已经启动；


 `k8s.io/kubernetes/cmd/kubelet/app/server.go:472`

```
func run(s *options.KubeletServer, kubeDeps *kubelet.Dependencies, stopCh <-chan struct{}) (err error) {
    // 1、为 kubelet 设置默认的 FeatureGates
    err = utilfeature.DefaultMutableFeatureGate.SetFromMap(s.KubeletConfiguration.FeatureGates)
    if err != nil {
        return err
    }
    // 2、校验 kubelet 的参数
    if err := options.ValidateKubeletServer(s); err != nil {
        return err
    }

    // 3、尝试获取 kubelet 的 lock file
    if s.ExitOnLockContention && s.LockFilePath == "" {
        return errors.New("cannot exit on lock file contention: no lock file specified")
    }
    done := make(chan struct{})
    if s.LockFilePath != "" {
        klog.Infof("acquiring file lock on %q", s.LockFilePath)
        if err := flock.Acquire(s.LockFilePath); err != nil {
            return fmt.Errorf("unable to acquire file lock on %q: %v", s.LockFilePath, err)
        }
        if s.ExitOnLockContention {
            klog.Infof("watching for inotify events for: %v", s.LockFilePath)
            if err := watchForLockfileContention(s.LockFilePath, done); err != nil {
                return err
            }
        }
    }
    // 4、将当前的配置文件注册到 http server /configz URL 中；
    err = initConfigz(&s.KubeletConfiguration)
    if err != nil {
        klog.Errorf("unable to register KubeletConfiguration with configz, error: %v", err)
    }

    // 5、判断是否为 standalone 模式
    standaloneMode := true
    if len(s.KubeConfig) > 0 {
        standaloneMode = false
    }

    // 6、初始化 kubeDeps
    if kubeDeps == nil {
        kubeDeps, err = UnsecuredDependencies(s)
        if err != nil {
            return err
        }
    }
    if kubeDeps.Cloud == nil {
        if !cloudprovider.IsExternal(s.CloudProvider) {
            cloud, err := cloudprovider.InitCloudProvider(s.CloudProvider, s.CloudConfigFile)
            if err != nil {
                return err
            }
            ......
            kubeDeps.Cloud = cloud
        }
    }

    hostName, err := nodeutil.GetHostname(s.HostnameOverride)
    if err != nil {
        return err
    }
    nodeName, err := getNodeName(kubeDeps.Cloud, hostName)
    if err != nil {
        return err
    }
    // 7、如果是 standalone 模式将所有 client 设置为 nil
    switch {
    case standaloneMode:
        kubeDeps.KubeClient = nil
        kubeDeps.EventClient = nil
        kubeDeps.HeartbeatClient = nil
        
    // 8、为 kubeDeps 初始化 KubeClient、EventClient、HeartbeatClient 模块
    case kubeDeps.KubeClient == nil, kubeDeps.EventClient == nil, kubeDeps.HeartbeatClient == nil:
        clientConfig, closeAllConns, err := buildKubeletClientConfig(s, nodeName)
        if err != nil {
            return err
        }
        if closeAllConns == nil {
            return errors.New("closeAllConns must be a valid function other than nil")
        }
        kubeDeps.OnHeartbeatFailure = closeAllConns

        kubeDeps.KubeClient, err = clientset.NewForConfig(clientConfig)
        if err != nil {
            return fmt.Errorf("failed to initialize kubelet client: %v", err)
        }

        eventClientConfig := *clientConfig
        eventClientConfig.QPS = float32(s.EventRecordQPS)
        eventClientConfig.Burst = int(s.EventBurst)
        kubeDeps.EventClient, err = v1core.NewForConfig(&eventClientConfig)
        if err != nil {
            return fmt.Errorf("failed to initialize kubelet event client: %v", err)
        }
        
        heartbeatClientConfig := *clientConfig
        heartbeatClientConfig.Timeout = s.KubeletConfiguration.NodeStatusUpdateFrequency.Duration

        if utilfeature.DefaultFeatureGate.Enabled(features.NodeLease) {
            leaseTimeout := time.Duration(s.KubeletConfiguration.NodeLeaseDurationSeconds) * time.Second
            if heartbeatClientConfig.Timeout > leaseTimeout {
                heartbeatClientConfig.Timeout = leaseTimeout
            }
        }
        heartbeatClientConfig.QPS = float32(-1)
        kubeDeps.HeartbeatClient, err = clientset.NewForConfig(&heartbeatClientConfig)
        if err != nil {
            return fmt.Errorf("failed to initialize kubelet heartbeat client: %v", err)
        }
    }
    // 9、初始化 auth 模块
    if kubeDeps.Auth == nil {
        auth, err := BuildAuth(nodeName, kubeDeps.KubeClient, s.KubeletConfiguration)
        if err != nil {
            return err
        }
        kubeDeps.Auth = auth
    }

    var cgroupRoots []string

    // 10、设置 cgroupRoot
    cgroupRoots = append(cgroupRoots, cm.NodeAllocatableRoot(s.CgroupRoot, s.CgroupDriver))
    kubeletCgroup, err := cm.GetKubeletContainer(s.KubeletCgroups)
    if err != nil {
    } else if kubeletCgroup != "" {
        cgroupRoots = append(cgroupRoots, kubeletCgroup)
    }

    runtimeCgroup, err := cm.GetRuntimeContainer(s.ContainerRuntime, s.RuntimeCgroups)
    if err != nil {
    } else if runtimeCgroup != "" {
        cgroupRoots = append(cgroupRoots, runtimeCgroup)
    }
    if s.SystemCgroups != "" {
        cgroupRoots = append(cgroupRoots, s.SystemCgroups)
    }

    // 11、初始化 cadvisor
    if kubeDeps.CAdvisorInterface == nil {
        imageFsInfoProvider := cadvisor.NewImageFsInfoProvider(s.ContainerRuntime, s.RemoteRuntimeEndpoint)
        kubeDeps.CAdvisorInterface, err = cadvisor.New(imageFsInfoProvider, s.RootDirectory, cgroupRoots, cadvisor.UsingLegacyCadvisorStats(s.           ContainerRuntime, s.RemoteRuntimeEndpoint))
        if err != nil {
            return err
        }
    }

    makeEventRecorder(kubeDeps, nodeName)

    // 12、初始化 ContainerManager
    if kubeDeps.ContainerManager == nil {
        if s.CgroupsPerQOS && s.CgroupRoot == "" {
            s.CgroupRoot = "/"
        }
        kubeReserved, err := parseResourceList(s.KubeReserved)
        if err != nil {
            return err
        }
        systemReserved, err := parseResourceList(s.SystemReserved)
        if err != nil {
            return err
        }
        var hardEvictionThresholds []evictionapi.Threshold
        if !s.ExperimentalNodeAllocatableIgnoreEvictionThreshold {
            hardEvictionThresholds, err = eviction.ParseThresholdConfig([]string{}, s.EvictionHard, nil, nil, nil)
            if err != nil {
                return err
            }
        }
        experimentalQOSReserved, err := cm.ParseQOSReserved(s.QOSReserved)
        if err != nil {
            return err
        }

        devicePluginEnabled := utilfeature.DefaultFeatureGate.Enabled(features.DevicePlugins)
        kubeDeps.ContainerManager, err = cm.NewContainerManager(
            kubeDeps.Mounter,
            kubeDeps.CAdvisorInterface,
            cm.NodeConfig{
            	......
            },
            s.FailSwapOn,
            devicePluginEnabled,
            kubeDeps.Recorder)
        if err != nil {
            return err
        }
    }

    // 13、检查是否以 root 权限启动
    if err := checkPermissions(); err != nil {
        klog.Error(err)
    }

    utilruntime.ReallyCrash = s.ReallyCrashForTesting

    // 14、为 kubelet 进程设置 oom 分数
    oomAdjuster := kubeDeps.OOMAdjuster
    if err := oomAdjuster.ApplyOOMScoreAdj(0, int(s.OOMScoreAdj)); err != nil {
        klog.Warning(err)
    }

    // 15、调用 RunKubelet 方法执行后续的启动操作
    if err := RunKubelet(s, kubeDeps, s.RunOnce); err != nil {
        return err
    }
    
    if utilfeature.DefaultFeatureGate.Enabled(features.DynamicKubeletConfig) && len(s.DynamicConfigDir.Value()) > 0 &&
        kubeDeps.KubeletConfigController != nil && !standaloneMode && !s.RunOnce {
        if err := kubeDeps.KubeletConfigController.StartSync(kubeDeps.KubeClient, kubeDeps.EventClient, string(nodeName)); err != nil {
            return err
        }
    }

    // 16、启动 Healthz http server
    if s.HealthzPort > 0 {
        mux := http.NewServeMux()
        healthz.InstallHandler(mux)
        go wait.Until(func() {
            err := http.ListenAndServe(net.JoinHostPort(s.HealthzBindAddress, strconv.Itoa(int(s.HealthzPort))), mux)
            if err != nil {
                klog.Errorf("Starting healthz server failed: %v", err)
            }
        }, 5*time.Second, wait.NeverStop)
    }

    if s.RunOnce {
        return nil
    }

    // 17、向 systemd 发送启动信号
    go daemon.SdNotify(false, "READY=1")

    select {
    case <-done:
        break
    case <-stopCh:
        break
    }
    return nil
}
```



#### RunKubelet

`RunKubelet` 中主要调用了 `createAndInitKubelet` 方法执行 kubelet 组件的初始化，然后调用 `startKubelet` 启动 kubelet 中的组件。



`k8s.io/kubernetes/cmd/kubelet/app/server.go:989`

```
func RunKubelet(kubeServer *options.KubeletServer, kubeDeps *kubelet.Dependencies, runOnce bool) error {
    hostname, err := nodeutil.GetHostname(kubeServer.HostnameOverride)
    if err != nil {
        return err
    }
    nodeName, err := getNodeName(kubeDeps.Cloud, hostname)
    if err != nil {
        return err
    }
    makeEventRecorder(kubeDeps, nodeName)

    // 1、默认启动特权模式
    capabilities.Initialize(capabilities.Capabilities{
        AllowPrivileged: true,
    })

    credentialprovider.SetPreferredDockercfgPath(kubeServer.RootDirectory)

    if kubeDeps.OSInterface == nil {
        kubeDeps.OSInterface = kubecontainer.RealOS{}
    }
    
    // 2、调用 createAndInitKubelet
    k, err := createAndInitKubelet(&kubeServer.KubeletConfiguration,
        ......
        kubeServer.NodeStatusMaxImages)
    if err != nil {
        return fmt.Errorf("failed to create kubelet: %v", err)
    }

    if kubeDeps.PodConfig == nil {
        return fmt.Errorf("failed to create kubelet, pod source config was nil")
    }
    podCfg := kubeDeps.PodConfig

    rlimit.RlimitNumFiles(uint64(kubeServer.MaxOpenFiles))

    if runOnce {
        if _, err := k.RunOnce(podCfg.Updates()); err != nil {
            return fmt.Errorf("runonce failed: %v", err)
        }
        klog.Info("Started kubelet as runonce")
    } else {
        // 3、调用 startKubelet
        startKubelet(k, podCfg, &kubeServer.KubeletConfiguration, kubeDeps, kubeServer.EnableCAdvisorJSONEndpoints, kubeServer.EnableServer)
        klog.Info("Started kubelet")
    }
    return nil
}
```



#### createAndInitKubelet

`createAndInitKubelet` 中主要调用了三个方法来完成 kubelet 的初始化：
- `kubelet.NewMainKubelet`：实例化 kubelet 对象，并对 kubelet 依赖的所有模块进行初始化；
- `k.BirthCry`：向 apiserver 发送一条 kubelet 启动了的 event；
- `k.StartGarbageCollection`：启动垃圾回收服务，回收 container 和 images；



`k8s.io/kubernetes/cmd/kubelet/app/server.go:1089`

```
func createAndInitKubelet(......) {
    k, err = kubelet.NewMainKubelet(
            ......
    )
    if err != nil {
        return nil, err
    }

    k.BirthCry()

    k.StartGarbageCollection()

    return k, nil
}
```



##### kubelet.NewMainKubelet

`NewMainKubelet` 是初始化 kubelet 的一个方法，主要逻辑为：
- 1、初始化 PodConfig 即监听 pod 元数据的来源(file，http，apiserver)，将不同 source 的 pod configuration 合并到一个结构中；
- 2、初始化 containerGCPolicy、imageGCPolicy、evictionConfig 配置；
- 3、启动 serviceInformer 和 nodeInformer；
- 4、初始化 `containerRefManager`、`oomWatcher`；
- 5、初始化 kubelet 对象；
- 6、初始化 `secretManager`、`configMapManager`；
- 7、初始化 `livenessManager`、`podManager`、`statusManager`、`resourceAnalyzer`；
- 8、调用 `kuberuntime.NewKubeGenericRuntimeManager` 初始化 `containerRuntime`；
- 9、初始化 `pleg`；
- 10、初始化 `containerGC`、`containerDeletor`、`imageManager`、`containerLogManager`；
- 11、初始化 `serverCertificateManager`、`probeManager`、`tokenManager`、`volumePluginMgr`、`pluginManager`、`volumeManager`；
- 12、初始化 `workQueue`、`podWorkers`、`evictionManager`；
- 13、最后注册相关模块的 handler；

`NewMainKubelet` 中对 kubelet 依赖的所有模块进行了初始化，每个模块对应的功能在上篇文章“kubelet 架构浅析”有介绍，至于每个模块初始化的流程以及功能会在后面的文章中进行详细分析。



`k8s.io/kubernetes/pkg/kubelet/kubelet.go:335`

```
func NewMainKubelet(kubeCfg *kubeletconfiginternal.KubeletConfiguration,) {
    if rootDirectory == "" {
        return nil, fmt.Errorf("invalid root directory %q", rootDirectory)
    }
    if kubeCfg.SyncFrequency.Duration <= 0 {
        return nil, fmt.Errorf("invalid sync frequency %d", kubeCfg.SyncFrequency.Duration)
    }

    if kubeCfg.MakeIPTablesUtilChains {
        ......
    }

    hostname, err := nodeutil.GetHostname(hostnameOverride)
    if err != nil {
        return nil, err
    }

    nodeName := types.NodeName(hostname)
    if kubeDeps.Cloud != nil {
        ......
    }

    // 1、初始化 PodConfig
    if kubeDeps.PodConfig == nil {
        var err error
        kubeDeps.PodConfig, err = makePodSourceConfig(kubeCfg, kubeDeps, nodeName, bootstrapCheckpointPath)
        if err != nil {
            return nil, err
        }
    }

    // 2、初始化 containerGCPolicy、imageGCPolicy、evictionConfig
    containerGCPolicy := kubecontainer.ContainerGCPolicy{
        MinAge:             minimumGCAge.Duration,
        MaxPerPodContainer: int(maxPerPodContainerCount),
        MaxContainers:      int(maxContainerCount),
    }
    daemonEndpoints := &v1.NodeDaemonEndpoints{
        KubeletEndpoint: v1.DaemonEndpoint{Port: kubeCfg.Port},
    }

    imageGCPolicy := images.ImageGCPolicy{
        MinAge:               kubeCfg.ImageMinimumGCAge.Duration,
        HighThresholdPercent: int(kubeCfg.ImageGCHighThresholdPercent),
        LowThresholdPercent:  int(kubeCfg.ImageGCLowThresholdPercent),
    }

    enforceNodeAllocatable := kubeCfg.EnforceNodeAllocatable
    if experimentalNodeAllocatableIgnoreEvictionThreshold {
        enforceNodeAllocatable = []string{}
    }
    thresholds, err := eviction.ParseThresholdConfig(enforceNodeAllocatable, kubeCfg.EvictionHard, kubeCfg.EvictionSoft, kubeCfg.                        EvictionSoftGracePeriod, kubeCfg.EvictionMinimumReclaim)
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
    // 3、启动 serviceInformer 和 nodeInformer
    serviceIndexer := cache.NewIndexer(cache.MetaNamespaceKeyFunc, cache.Indexers{cache.NamespaceIndex: cache.MetaNamespaceIndexFunc})
    if kubeDeps.KubeClient != nil {
        serviceLW := cache.NewListWatchFromClient(kubeDeps.KubeClient.CoreV1().RESTClient(), "services", metav1.NamespaceAll, fields.Everything())
        r := cache.NewReflector(serviceLW, &v1.Service{}, serviceIndexer, 0)
        go r.Run(wait.NeverStop)
    }
    serviceLister := corelisters.NewServiceLister(serviceIndexer)

    nodeIndexer := cache.NewIndexer(cache.MetaNamespaceKeyFunc, cache.Indexers{})
    if kubeDeps.KubeClient != nil {
        fieldSelector := fields.Set{api.ObjectNameField: string(nodeName)}.AsSelector()
        nodeLW := cache.NewListWatchFromClient(kubeDeps.KubeClient.CoreV1().RESTClient(), "nodes", metav1.NamespaceAll, fieldSelector)
        r := cache.NewReflector(nodeLW, &v1.Node{}, nodeIndexer, 0)
        go r.Run(wait.NeverStop)
    }
    nodeInfo := &CachedNodeInfo{NodeLister: corelisters.NewNodeLister(nodeIndexer)}

	......
		
    // 4、初始化 containerRefManager、oomWatcher
    containerRefManager := kubecontainer.NewRefManager()

    oomWatcher := oomwatcher.NewWatcher(kubeDeps.Recorder)
    clusterDNS := make([]net.IP, 0, len(kubeCfg.ClusterDNS))
    for _, ipEntry := range kubeCfg.ClusterDNS {
        ip := net.ParseIP(ipEntry)
        if ip == nil {
            klog.Warningf("Invalid clusterDNS ip '%q'", ipEntry)
        } else {
            clusterDNS = append(clusterDNS, ip)
        }
    }
    httpClient := &http.Client{}
    parsedNodeIP := net.ParseIP(nodeIP)
    protocol := utilipt.ProtocolIpv4
    if parsedNodeIP != nil && parsedNodeIP.To4() == nil {
        protocol = utilipt.ProtocolIpv6
    }

    // 5、初始化 kubelet 对象
    klet := &Kubelet{......}

    if klet.cloud != nil {
        klet.cloudResourceSyncManager = cloudresource.NewSyncManager(klet.cloud, nodeName, klet.nodeStatusUpdateFrequency)
    }

    // 6、初始化 secretManager、configMapManager
    var secretManager secret.Manager
    var configMapManager configmap.Manager
    switch kubeCfg.ConfigMapAndSecretChangeDetectionStrategy {
    case kubeletconfiginternal.WatchChangeDetectionStrategy:
        secretManager = secret.NewWatchingSecretManager(kubeDeps.KubeClient)
        configMapManager = configmap.NewWatchingConfigMapManager(kubeDeps.KubeClient)
    case kubeletconfiginternal.TTLCacheChangeDetectionStrategy:
        secretManager = secret.NewCachingSecretManager(
            kubeDeps.KubeClient, manager.GetObjectTTLFromNodeFunc(klet.GetNode))
        configMapManager = configmap.NewCachingConfigMapManager(
            kubeDeps.KubeClient, manager.GetObjectTTLFromNodeFunc(klet.GetNode))
    case kubeletconfiginternal.GetChangeDetectionStrategy:
        secretManager = secret.NewSimpleSecretManager(kubeDeps.KubeClient)
        configMapManager = configmap.NewSimpleConfigMapManager(kubeDeps.KubeClient)
    default:
        return nil, fmt.Errorf("unknown configmap and secret manager mode: %v", kubeCfg.ConfigMapAndSecretChangeDetectionStrategy)
    }

    klet.secretManager = secretManager
    klet.configMapManager = configMapManager
    if klet.experimentalHostUserNamespaceDefaulting {
        klog.Infof("Experimental host user namespace defaulting is enabled.")
    }

    machineInfo, err := klet.cadvisor.MachineInfo()
    if err != nil {
        return nil, err
    }
    klet.machineInfo = machineInfo

    imageBackOff := flowcontrol.NewBackOff(backOffPeriod, MaxContainerBackOff)

    // 7、初始化 livenessManager、podManager、statusManager、resourceAnalyzer
    klet.livenessManager = proberesults.NewManager()

    klet.podCache = kubecontainer.NewCache()
    var checkpointManager checkpointmanager.CheckpointManager
    if bootstrapCheckpointPath != "" {
        checkpointManager, err = checkpointmanager.NewCheckpointManager(bootstrapCheckpointPath)
        if err != nil {
            return nil, fmt.Errorf("failed to initialize checkpoint manager: %+v", err)
        }
    }

    klet.podManager = kubepod.NewBasicPodManager(kubepod.NewBasicMirrorClient(klet.kubeClient), secretManager, configMapManager, checkpointManager)

    klet.statusManager = status.NewManager(klet.kubeClient, klet.podManager, klet)

    if remoteRuntimeEndpoint != "" {
        if remoteImageEndpoint == "" {
            remoteImageEndpoint = remoteRuntimeEndpoint
        }
    }

    pluginSettings := dockershim.NetworkPluginSettings{......}

    klet.resourceAnalyzer = serverstats.NewResourceAnalyzer(klet, kubeCfg.VolumeStatsAggPeriod.Duration)

    var legacyLogProvider kuberuntime.LegacyLogProvider

    // 8、调用 kuberuntime.NewKubeGenericRuntimeManager 初始化 containerRuntime
    switch containerRuntime {
    case kubetypes.DockerContainerRuntime:
        streamingConfig := getStreamingConfig(kubeCfg, kubeDeps, crOptions)
        ds, err := dockershim.NewDockerService(kubeDeps.DockerClientConfig, crOptions.PodSandboxImage, streamingConfig,
            &pluginSettings, runtimeCgroups, kubeCfg.CgroupDriver, crOptions.DockershimRootDirectory, !crOptions.RedirectContainerStreaming)
        if err != nil {
            return nil, err
        }
        if crOptions.RedirectContainerStreaming {
            klet.criHandler = ds
        }

        server := dockerremote.NewDockerServer(remoteRuntimeEndpoint, ds)
        if err := server.Start(); err != nil {
            return nil, err
        }

        supported, err := ds.IsCRISupportedLogDriver()
        if err != nil {
            return nil, err
        }
        if !supported {
            klet.dockerLegacyService = ds
            legacyLogProvider = ds
        }
    case kubetypes.RemoteContainerRuntime:
        break
    default:
        return nil, fmt.Errorf("unsupported CRI runtime: %q", containerRuntime)
    }
    runtimeService, imageService, err := getRuntimeAndImageServices(remoteRuntimeEndpoint, remoteImageEndpoint, kubeCfg.RuntimeRequestTimeout)
    if err != nil {
        return nil, err
    }
    klet.runtimeService = runtimeService
    if utilfeature.DefaultFeatureGate.Enabled(features.RuntimeClass) && kubeDeps.KubeClient != nil {
        klet.runtimeClassManager = runtimeclass.NewManager(kubeDeps.KubeClient)
    }

    runtime, err := kuberuntime.NewKubeGenericRuntimeManager(......)
    if err != nil {
        return nil, err
    }
    klet.containerRuntime = runtime
    klet.streamingRuntime = runtime
    klet.runner = runtime

    runtimeCache, err := kubecontainer.NewRuntimeCache(klet.containerRuntime)
    if err != nil {
        return nil, err
    }
    klet.runtimeCache = runtimeCache

    if cadvisor.UsingLegacyCadvisorStats(containerRuntime, remoteRuntimeEndpoint) {
        klet.StatsProvider = stats.NewCadvisorStatsProvider(......)
    } else {
        klet.StatsProvider = stats.NewCRIStatsProvider(......)
    }
    // 9、初始化 pleg
    klet.pleg = pleg.NewGenericPLEG(klet.containerRuntime, plegChannelCapacity, plegRelistPeriod, klet.podCache, clock.RealClock{})
    klet.runtimeState = newRuntimeState(maxWaitForContainerRuntime)
    klet.runtimeState.addHealthCheck("PLEG", klet.pleg.Healthy)
    if _, err := klet.updatePodCIDR(kubeCfg.PodCIDR); err != nil {
        klog.Errorf("Pod CIDR update failed %v", err)
    }

    // 10、初始化 containerGC、containerDeletor、imageManager、containerLogManager
    containerGC, err := kubecontainer.NewContainerGC(klet.containerRuntime, containerGCPolicy, klet.sourcesReady)
    if err != nil {
        return nil, err
    }
    klet.containerGC = containerGC
    klet.containerDeletor = newPodContainerDeletor(klet.containerRuntime, integer.IntMax(containerGCPolicy.MaxPerPodContainer, minDeadContainerInPod))

    imageManager, err := images.NewImageGCManager(klet.containerRuntime, klet.StatsProvider, kubeDeps.Recorder, nodeRef, imageGCPolicy, crOptions.       PodSandboxImage)
    if err != nil {
        return nil, fmt.Errorf("failed to initialize image manager: %v", err)
    }
    klet.imageManager = imageManager

    if containerRuntime == kubetypes.RemoteContainerRuntime && utilfeature.DefaultFeatureGate.Enabled(features.CRIContainerLogRotation) {
        containerLogManager, err := logs.NewContainerLogManager(
            klet.runtimeService,
            kubeCfg.ContainerLogMaxSize,
            int(kubeCfg.ContainerLogMaxFiles),
        )
        if err != nil {
            return nil, fmt.Errorf("failed to initialize container log manager: %v", err)
        }
        klet.containerLogManager = containerLogManager
    } else {
        klet.containerLogManager = logs.NewStubContainerLogManager()
    }
    // 11、初始化 serverCertificateManager、probeManager、tokenManager、volumePluginMgr、pluginManager、volumeManager
    if kubeCfg.ServerTLSBootstrap && kubeDeps.TLSOptions != nil && utilfeature.DefaultFeatureGate.Enabled(features.RotateKubeletServerCertificate) {
        klet.serverCertificateManager, err = kubeletcertificate.NewKubeletServerCertificateManager(klet.kubeClient, kubeCfg, klet.nodeName, klet.        getLastObservedNodeAddresses, certDirectory)
        if err != nil {
            return nil, fmt.Errorf("failed to initialize certificate manager: %v", err)
        }
        kubeDeps.TLSOptions.Config.GetCertificate = func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
            cert := klet.serverCertificateManager.Current()
            if cert == nil {
                return nil, fmt.Errorf("no serving certificate available for the kubelet")
            }
            return cert, nil
        }
    }

    klet.probeManager = prober.NewManager(......)
    tokenManager := token.NewManager(kubeDeps.KubeClient)

    klet.volumePluginMgr, err =
        NewInitializedVolumePluginMgr(klet, secretManager, configMapManager, tokenManager, kubeDeps.VolumePlugins, kubeDeps.DynamicPluginProber)
    if err != nil {
        return nil, err
    }
    klet.pluginManager = pluginmanager.NewPluginManager(
        klet.getPluginsRegistrationDir(), /* sockDir */
        klet.getPluginsDir(),             /* deprecatedSockDir */
        kubeDeps.Recorder,
    )

    if len(experimentalMounterPath) != 0 {
        experimentalCheckNodeCapabilitiesBeforeMount = false
        klet.dnsConfigurer.SetupDNSinContainerizedMounter(experimentalMounterPath)
    }
    klet.volumeManager = volumemanager.NewVolumeManager(......)

    // 12、初始化 workQueue、podWorkers、evictionManager
    klet.reasonCache = NewReasonCache()
    klet.workQueue = queue.NewBasicWorkQueue(klet.clock)
    klet.podWorkers = newPodWorkers(klet.syncPod, kubeDeps.Recorder, klet.workQueue, klet.resyncInterval, backOffPeriod, klet.podCache)

    klet.backOff = flowcontrol.NewBackOff(backOffPeriod, MaxContainerBackOff)
    klet.podKillingCh = make(chan *kubecontainer.PodPair, podKillingChannelCapacity)

    evictionManager, evictionAdmitHandler := eviction.NewManager(klet.resourceAnalyzer, evictionConfig, killPodNow(klet.podWorkers, kubeDeps.Recorder),  klet.podManager.GetMirrorPodByPod, klet.imageManager, klet.containerGC, kubeDeps.Recorder, nodeRef, klet.clock)

    klet.evictionManager = evictionManager
    klet.admitHandlers.AddPodAdmitHandler(evictionAdmitHandler)
    if utilfeature.DefaultFeatureGate.Enabled(features.Sysctls) {
        runtimeSupport, err := sysctl.NewRuntimeAdmitHandler(klet.containerRuntime)
        if err != nil {
            return nil, err
        }

        safeAndUnsafeSysctls := append(sysctlwhitelist.SafeSysctlWhitelist(), allowedUnsafeSysctls...)
        sysctlsWhitelist, err := sysctl.NewWhitelist(safeAndUnsafeSysctls)
        if err != nil {
            return nil, err
        }
        klet.admitHandlers.AddPodAdmitHandler(runtimeSupport)
        klet.admitHandlers.AddPodAdmitHandler(sysctlsWhitelist)
    }

    // 13、为 pod 注册相关模块的 handler
    activeDeadlineHandler, err := newActiveDeadlineHandler(klet.statusManager, kubeDeps.Recorder, klet.clock)
    if err != nil {
        return nil, err
    }
    klet.AddPodSyncLoopHandler(activeDeadlineHandler)
    klet.AddPodSyncHandler(activeDeadlineHandler)
    if utilfeature.DefaultFeatureGate.Enabled(features.TopologyManager) {
        klet.admitHandlers.AddPodAdmitHandler(klet.containerManager.GetTopologyPodAdmitHandler())
    }
    criticalPodAdmissionHandler := preemption.NewCriticalPodAdmissionHandler(klet.GetActivePods, killPodNow(klet.podWorkers, kubeDeps.Recorder),kubeDeps.Recorder)
    klet.admitHandlers.AddPodAdmitHandler(lifecycle.NewPredicateAdmitHandler(klet.getNodeAnyWay, criticalPodAdmissionHandler, klet.containerManager.UpdatePluginResources))
    for _, opt := range kubeDeps.Options {
        opt(klet)
    }

    klet.appArmorValidator = apparmor.NewValidator(containerRuntime)
    klet.softAdmitHandlers.AddPodAdmitHandler(lifecycle.NewAppArmorAdmitHandler(klet.appArmorValidator))
    klet.softAdmitHandlers.AddPodAdmitHandler(lifecycle.NewNoNewPrivsAdmitHandler(klet.containerRuntime))

    if utilfeature.DefaultFeatureGate.Enabled(features.NodeLease) {
        klet.nodeLeaseController = nodelease.NewController(klet.clock, klet.heartbeatClient, string(klet.nodeName), kubeCfg.NodeLeaseDurationSeconds,    klet.onRepeatedHeartbeatFailure)
    }

    klet.softAdmitHandlers.AddPodAdmitHandler(lifecycle.NewProcMountAdmitHandler(klet.containerRuntime))

    klet.kubeletConfiguration = *kubeCfg

    klet.setNodeStatusFuncs = klet.defaultNodeStatusFuncs()

    return klet, nil
}
```





#### startKubelet

在`startKubelet` 中通过调用 `k.Run` 来启动 kubelet 中的所有模块以及主流程，然后启动 kubelet 所需要的 http server，在 v1.16 中，kubelet 默认仅启动健康检查端口 10248 和 kubelet server 的端口 10250。 



`k8s.io/kubernetes/cmd/kubelet/app/server.go:1070`

```
func startKubelet(k kubelet.Bootstrap, podCfg *config.PodConfig, kubeCfg *kubeletconfiginternal.KubeletConfiguration, kubeDeps *kubelet.Dependencies,    enableCAdvisorJSONEndpoints, enableServer bool) {
    // start the kubelet
    go wait.Until(func() {
        k.Run(podCfg.Updates())
    }, 0, wait.NeverStop)

    // start the kubelet server
    if enableServer {
        go k.ListenAndServe(net.ParseIP(kubeCfg.Address), uint(kubeCfg.Port), kubeDeps.TLSOptions, kubeDeps.Auth, enableCAdvisorJSONEndpoints, kubeCfg.  EnableDebuggingHandlers, kubeCfg.EnableContentionProfiling)

    }
    if kubeCfg.ReadOnlyPort > 0 {
        go k.ListenAndServeReadOnly(net.ParseIP(kubeCfg.Address), uint(kubeCfg.ReadOnlyPort), enableCAdvisorJSONEndpoints)
    }
    if utilfeature.DefaultFeatureGate.Enabled(features.KubeletPodResources) {
        go k.ListenAndServePodResources()
    }
}
```



至此，kubelet 对象以及其依赖模块在上面的几个方法中已经初始化完成了，除了单独启动了 gc 模块外其余的模块以及主逻辑最后都会在 `Run` 方法启动，`Run` 方法的主要逻辑在下文中会进行解释，此处总结一下 kubelet 启动逻辑中的调用关系如下所示：

```
                                                                                  |--> NewMainKubelet
                                                                                  |
                                                      |--> createAndInitKubelet --|--> BirthCry
                                                      |                           |
                                    |--> RunKubelet --|                           |--> StartGarbageCollection
                                    |                 |
                                    |                  |--> startKubelet --> k.Run
                                    |
NewKubeletCommand --> Run --> run --|--> http.ListenAndServe
                                    |
                                    |--> daemon.SdNotify

```



### Run

`Run` 方法是启动 kubelet 的核心方法，其中会启动 kubelet 的依赖模块以及主循环逻辑，该方法的主要逻辑为：
- 1、注册 logServer；
- 2、判断是否需要启动 cloud provider sync manager；
- 3、调用 `kl.initializeModules` 首先启动不依赖 container runtime 的一些模块；
- 4、启动 `volume manager`；
- 5、执行 `kl.syncNodeStatus` 定时同步 Node 状态；
- 6、调用 `kl.fastStatusUpdateOnce` 更新容器运行时启动时间以及执行首次状态同步；
- 7、判断是否启用 `NodeLease` 机制；
- 8、执行 `kl.updateRuntimeUp` 定时更新 Runtime 状态；
- 9、执行 `kl.syncNetworkUtil` 定时同步 iptables 规则；
- 10、执行 `kl.podKiller` 定时清理异常 pod，当 pod 没有被 podworker 正确处理的时候，启动一个goroutine 负责 kill 掉 pod；
- 11、启动 `statusManager`；
- 12、启动 `probeManager`；
- 13、启动 `runtimeClassManager`；
- 14、启动 `pleg`；
- 15、调用 `kl.syncLoop` 监听 pod 变化；



在 `Run` 方法中主要调用了两个方法 `kl.initializeModules` 和 `kl.fastStatusUpdateOnce` 来完成启动前的一些初始化，在初始化完所有的模块后会启动主循环。



`k8s.io/kubernetes/pkg/kubelet/kubelet.go:1398`

```
func (kl *Kubelet) Run(updates <-chan kubetypes.PodUpdate) {
    // 1、注册 logServer
    if kl.logServer == nil {
        kl.logServer = http.StripPrefix("/logs/", http.FileServer(http.Dir("/var/log/")))
    }
    if kl.kubeClient == nil {
        klog.Warning("No api server defined - no node status update will be sent.")
    }

    // 2、判断是否需要启动 cloud provider sync manager
    if kl.cloudResourceSyncManager != nil {
       go kl.cloudResourceSyncManager.Run(wait.NeverStop)
    }

    // 3、调用 kl.initializeModules 首先启动不依赖 container runtime 的一些模块
    if err := kl.initializeModules(); err != nil {
        kl.recorder.Eventf(kl.nodeRef, v1.EventTypeWarning, events.KubeletSetupFailed, err.Error())
        klog.Fatal(err)
    }

    // 4、启动 volume manager
    go kl.volumeManager.Run(kl.sourcesReady, wait.NeverStop)

    if kl.kubeClient != nil {
        // 5、执行 kl.syncNodeStatus 定时同步 Node 状态
        go wait.Until(kl.syncNodeStatus, kl.nodeStatusUpdateFrequency, wait.NeverStop)
        
        // 6、调用 kl.fastStatusUpdateOnce 更新容器运行时启动时间以及执行首次状态同步
        go kl.fastStatusUpdateOnce()

        // 7、判断是否启用 NodeLease 机制
        if utilfeature.DefaultFeatureGate.Enabled(features.NodeLease) {
            go kl.nodeLeaseController.Run(wait.NeverStop)
        }
    }
    
    // 8、执行 kl.updateRuntimeUp 定时更新 Runtime 状态
    go wait.Until(kl.updateRuntimeUp, 5*time.Second, wait.NeverStop)

    // 9、执行 kl.syncNetworkUtil 定时同步 iptables 规则
    if kl.makeIPTablesUtilChains {
        go wait.Until(kl.syncNetworkUtil, 1*time.Minute, wait.NeverStop)
    }

    // 10、执行 kl.podKiller 定时清理异常 pod
    go wait.Until(kl.podKiller, 1*time.Second, wait.NeverStop)

    // 11、启动 statusManager、probeManager、runtimeClassManager
    kl.statusManager.Start()
    kl.probeManager.Start()

    if kl.runtimeClassManager != nil {
        kl.runtimeClassManager.Start(wait.NeverStop)
    }

    // 12、启动 pleg
    kl.pleg.Start()
    
    // 13、调用 kl.syncLoop 监听 pod 变化
    kl.syncLoop(updates, kl)
}
```



#### initializeModules

`initializeModules` 中启动的模块是不依赖于 container runtime 的，并且不依赖于尚未初始化的模块，其主要逻辑为：
- 1、调用 `kl.setupDataDirs` 创建 kubelet 所需要的文件目录；
- 2、创建 ContainerLogsDir `/var/log/containers`；
- 3、启动 `imageManager`，image gc 的功能已经在 RunKubelet 中启动了，此处主要是监控 image 的变化；
- 4、启动 `certificateManager`，负责证书更新；
- 5、启动 `oomWatcher`，监听 oom 并记录事件；
- 6、启动 `resourceAnalyzer`；



`k8s.io/kubernetes/pkg/kubelet/kubelet.go:1319`

```
func (kl *Kubelet) initializeModules() error {
    metrics.Register(
        kl.runtimeCache,
        collectors.NewVolumeStatsCollector(kl),
        collectors.NewLogMetricsCollector(kl.StatsProvider.ListPodStats),
    )
    metrics.SetNodeName(kl.nodeName)
    servermetrics.Register()

    // 1、创建文件目录
    if err := kl.setupDataDirs(); err != nil {
        return err
    }

    // 2、创建 ContainerLogsDir
    if _, err := os.Stat(ContainerLogsDir); err != nil {
        if err := kl.os.MkdirAll(ContainerLogsDir, 0755); err != nil {
            klog.Errorf("Failed to create directory %q: %v", ContainerLogsDir, err)
        }
    }

    // 3、启动 imageManager
    kl.imageManager.Start()

    // 4、启动 certificate manager 
    if kl.serverCertificateManager != nil {
        kl.serverCertificateManager.Start()
    }
    // 5、启动 oomWatcher.
    if err := kl.oomWatcher.Start(kl.nodeRef); err != nil {
        return fmt.Errorf("failed to start OOM watcher %v", err)
    }

    // 6、启动 resource analyzer
    kl.resourceAnalyzer.Start()

    return nil
}
```



#### fastStatusUpdateOnce

`fastStatusUpdateOnce` 会不断尝试更新 pod CIDR，一旦更新成功会立即执行`updateRuntimeUp`和`syncNodeStatus`来进行运行时的更新和节点状态更新。此方法只在 kubelet 启动时执行一次，目的是为了通过更新 pod CIDR，减少节点达到 ready 状态的时延，尽可能快的进行 runtime update 和 node status update。



`k8s.io/kubernetes/pkg/kubelet/kubelet.go:2262`

```
func (kl *Kubelet) fastStatusUpdateOnce() {
    for {
        time.Sleep(100 * time.Millisecond)
        node, err := kl.GetNode()
        if err != nil {
            klog.Errorf(err.Error())
            continue
        }
        if len(node.Spec.PodCIDRs) != 0 {
            podCIDRs := strings.Join(node.Spec.PodCIDRs, ",")
            if _, err := kl.updatePodCIDR(podCIDRs); err != nil {
                klog.Errorf("Pod CIDR update to %v failed %v", podCIDRs, err)
                continue
            }
            kl.updateRuntimeUp()
            kl.syncNodeStatus()
            return
        }
    }
}
```



##### updateRuntimeUp

`updateRuntimeUp` 方法在容器运行时首次启动过程中初始化运行时依赖的模块，并在 kubelet 的`runtimeState`中更新容器运行时的启动时间。`updateRuntimeUp` 方法首先检查 network 以及 runtime 是否处于  ready 状态，如果 network 以及 runtime 都处于 ready 状态，然后调用 `initializeRuntimeDependentModules` 初始化 runtime 的依赖模块，包括 `cadvisor`、`containerManager`、`evictionManager`、`containerLogManager`、`pluginManage`等。



`k8s.io/kubernetes/pkg/kubelet/kubelet.go:2168`

```
func (kl *Kubelet) updateRuntimeUp() {
    kl.updateRuntimeMux.Lock()
    defer kl.updateRuntimeMux.Unlock()

    // 1、获取 containerRuntime Status
    s, err := kl.containerRuntime.Status()
    if err != nil {
        klog.Errorf("Container runtime sanity check failed: %v", err)
        return
    }
    if s == nil {
        klog.Errorf("Container runtime status is nil")
        return
    }

    // 2、检查 network 和 runtime 是否处于 ready 状态
    networkReady := s.GetRuntimeCondition(kubecontainer.NetworkReady)
    if networkReady == nil || !networkReady.Status {
        kl.runtimeState.setNetworkState(fmt.Errorf("runtime network not ready: %v", networkReady))
    } else {
        kl.runtimeState.setNetworkState(nil)
    }

    runtimeReady := s.GetRuntimeCondition(kubecontainer.RuntimeReady)
    if runtimeReady == nil || !runtimeReady.Status {
        kl.runtimeState.setRuntimeState(err)
        return
    }
    kl.runtimeState.setRuntimeState(nil)
    // 3、调用 kl.initializeRuntimeDependentModules 启动依赖模块
    kl.oneTimeInitializer.Do(kl.initializeRuntimeDependentModules)
    kl.runtimeState.setRuntimeSync(kl.clock.Now())
}
```



###### initializeRuntimeDependentModules

该方法的主要逻辑为：
- 1、启动 `cadvisor`；
- 2、获取 CgroupStats；
- 3、启动 `containerManager`、`evictionManager`、`containerLogManager`；
- 4、将 CSI Driver 和 Device Manager 注册到 `pluginManager`，然后启动 `pluginManager`；



`k8s.io/kubernetes/pkg/kubelet/kubelet.go:1361`

```
func (kl *Kubelet) initializeRuntimeDependentModules() {
    // 1、启动 cadvisor
    if err := kl.cadvisor.Start(); err != nil {
        ......
    }

    // 2、获取 CgroupStats
    kl.StatsProvider.GetCgroupStats("/", true)

    node, err := kl.getNodeAnyWay()
    if err != nil {
        klog.Fatalf("Kubelet failed to get node info: %v", err)
    }

    // 3、启动 containerManager、evictionManager、containerLogManager
    if err := kl.containerManager.Start(node, kl.GetActivePods, kl.sourcesReady, kl.statusManager, kl.runtimeService); err != nil {
        klog.Fatalf("Failed to start ContainerManager %v", err)
    }

    kl.evictionManager.Start(kl.StatsProvider, kl.GetActivePods, kl.podResourcesAreReclaimed, evictionMonitoringPeriod)

    kl.containerLogManager.Start()

    kl.pluginManager.AddHandler(pluginwatcherapi.CSIPlugin, plugincache.PluginHandler(csi.PluginHandler))

    kl.pluginManager.AddHandler(pluginwatcherapi.DevicePlugin, kl.containerManager.GetPluginRegistrationHandler())
    // 4、启动 pluginManager
    go kl.pluginManager.Run(kl.sourcesReady, wait.NeverStop)
}
```



#### 小结

在 `Run` 方法中可以看到，会直接调用 `kl.syncNodeStatus`和 `kl.updateRuntimeUp`，但在 `kl.fastStatusUpdateOnce` 中也调用了这两个方法，而在 `kl.fastStatusUpdateOnce` 中仅执行一次，在 `Run` 方法中会定期执行。在`kl.fastStatusUpdateOnce` 中调用的目的就是当 kubelet 首次启动时尽可能快的进行 runtime update 和 node status update，减少节点达到 ready 状态的时延。而在 `kl.updateRuntimeUp` 中调用的初始化 runtime 依赖模块的方法 `kl.initializeRuntimeDependentModules` 通过 sync.Once 调用仅仅会被执行一次。 



#### syncLoop

`syncLoop` 是 kubelet 的主循环方法，它从不同的管道(file，http，apiserver)监听 pod 的变化，并把它们汇聚起来。当有新的变化发生时，它会调用对应的函数，保证 pod 处于期望的状态。

`syncLoop` 中首先定义了一个 `syncTicker` 和 `housekeepingTicker`，即使没有需要更新的 pod 配置，kubelet 也会定时去做同步和清理 pod 的工作。然后在 for 循环中一直调用 `syncLoopIteration`，如果在每次循环过程中出现错误时，kubelet 会记录到 `runtimeState` 中，遇到错误就等待 5 秒中继续循环。



`k8s.io/kubernetes/pkg/kubelet/kubelet.go:1821`

```
func (kl *Kubelet) syncLoop(updates <-chan kubetypes.PodUpdate, handler SyncHandler) {
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
        if err := kl.runtimeState.runtimeErrors(); err != nil {
            time.Sleep(duration)
            duration = time.Duration(math.Min(float64(max), factor*float64(duration)))
            continue
        }
        duration = base
        kl.syncLoopMonitor.Store(kl.clock.Now())
        if !kl.syncLoopIteration(updates, handler, syncTicker.C, housekeepingTicker.C, plegCh) {
            break
        }
        kl.syncLoopMonitor.Store(kl.clock.Now())
    }
}
```



##### syncLoopIteration

`syncLoopIteration` 方法会监听多个 channel，当发现任何一个 channel 有数据就交给 handler 去处理，在 handler 中通过调用 `dispatchWork` 分发任务。它会从以下几个 channel 中获取消息：

- 1、configCh：该信息源由 kubeDeps 对象中的 PodConfig 子模块提供，该模块将同时 watch 3 个不同来源的 pod 信息的变化（file，http，apiserver），一旦某个来源的 pod 信息发生了更新（创建/更新/删除），这个 channel 中就会出现被更新的 pod 信息和更新的具体操作；
- 2、syncCh：定时器，每隔一秒去同步最新保存的 pod 状态；
- 3、houseKeepingCh：housekeeping 事件的通道，做 pod 清理工作；
- 4、plegCh：该信息源由 kubelet 对象中的 pleg 子模块提供，该模块主要用于周期性地向 container runtime 查询当前所有容器的状态，如果状态发生变化，则这个 channel 产生事件；
- 5、liveness Manager：健康检查模块发现某个 pod 异常时，kubelet 将根据 pod 的 restartPolicy 自动执行正确的操作；



`k8s.io/kubernetes/pkg/kubelet/kubelet.go:1888`

```
func (kl *Kubelet) syncLoopIteration(......) bool {
    select {
    case u, open := <-configCh:
        if !open {
            return false
        }

        switch u.Op {
        case kubetypes.ADD:
            handler.HandlePodAdditions(u.Pods)
        case kubetypes.UPDATE:
            handler.HandlePodUpdates(u.Pods)
        case kubetypes.REMOVE:
            handler.HandlePodRemoves(u.Pods)
        case kubetypes.RECONCILE:
            handler.HandlePodReconcile(u.Pods)
        case kubetypes.DELETE:
            handler.HandlePodUpdates(u.Pods)
        case kubetypes.RESTORE:
            handler.HandlePodAdditions(u.Pods)
        case kubetypes.SET:
        }

        if u.Op != kubetypes.RESTORE {
            kl.sourcesReady.AddSource(u.Source)
        }
    case e := <-plegCh:
        if isSyncPodWorthy(e) {
            if pod, ok := kl.podManager.GetPodByUID(e.ID); ok {
                klog.V(2).Infof("SyncLoop (PLEG): %q, event: %#v", format.Pod(pod), e)
                handler.HandlePodSyncs([]*v1.Pod{pod})
            } else {
                klog.V(4).Infof("SyncLoop (PLEG): ignore irrelevant event: %#v", e)
            }
        }

        if e.Type == pleg.ContainerDied {
            if containerID, ok := e.Data.(string); ok {
                kl.cleanUpContainersInPod(e.ID, containerID)
            }
        }
    case <-syncCh:
        podsToSync := kl.getPodsToSync()
        if len(podsToSync) == 0 {
            break
        }
        handler.HandlePodSyncs(podsToSync)
    case update := <-kl.livenessManager.Updates():
        if update.Result == proberesults.Failure {
            pod, ok := kl.podManager.GetPodByUID(update.PodUID)
            if !ok {
                break
            }
            handler.HandlePodSyncs([]*v1.Pod{pod})
        }
    case <-housekeepingCh:
        if !kl.sourcesReady.AllReady() {
            klog.V(4).Infof("SyncLoop (housekeeping, skipped): sources aren't ready yet.")
        } else {
            if err := handler.HandlePodCleanups(); err != nil {
                klog.Errorf("Failed cleaning pods: %v", err)
            }
        }
    }
    return true
}
```



最后再总结一下启动 kubelet 以及其依赖模块 `Run` 方法中的调用流程：

```
      |--> kl.cloudResourceSyncManager.Run
      |
      |                            |--> kl.setupDataDirs
      |                            |--> kl.imageManager.Start
Run --|--> kl.initializeModules ---|--> kl.serverCertificateManager.Start
      |                            |--> kl.oomWatcher.Start
      |                            |--> kl.resourceAnalyzer.Start
      |
      |--> kl.volumeManager.Run
      |                                                        |--> kl.containerRuntime.Status
      |--> kl.syncNodeStatus                                   |
      |                              |--> kl.updateRuntimeUp --|                                           |--> kl.cadvisor.Start
      |                              |                         |                                           |
      |--> kl.fastStatusUpdateOnce --|                         |--> kl.initializeRuntimeDependentModules --|--> kl.containerManager.Start
      |                              |                                                                     |
      |                              |--> kl.syncNodeStatus                                                |--> kl.evictionManager.Start
      |                                                                                                    |
      |--> kl.updateRuntimeUp                                                                              |--> kl.containerLogManager.Start
      |                                                                                                    |
      |--> kl.syncNetworkUtil                                                                              |--> kl.pluginManager.Run
      |
      |--> kl.podKiller
      |
      |--> kl.statusManager.Start
      |
      |--> kl.probeManager.Start
      |
      |--> kl.runtimeClassManager.Start
      |
      |--> kl.pleg.Start
      |
      |--> kl.syncLoop --> kl.syncLoopIteration
```





### 总结



本文主要介绍了 kubelet 的启动流程，可以看到 kubelet 启动流程中的环节非常多，kubelet 中也包含了非常多的模块，后续在分享 kubelet 源码的文章中会先以 `Run` 方法中启动的所有模块为主，各个击破。



