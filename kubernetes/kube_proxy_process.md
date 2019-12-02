
<extoc></extoc>

上篇文章 [kubernetes service 原理解析](https://blog.tianfeiyu.com/2019/10/31/k8s_service_theory/) 已经分析了 service 原理以 kube-proxy 中三种模式的原理，本篇文章会从源码角度分析 kube-proxy 的设计与实现。

> kubernetes 版本: v1.16

## kube-proxy 启动流程

前面的文章已经说过 kubernetes 中所有组件都是通过其  `run()` 方法启动主逻辑的，`run()` 方法调用之前会进行解析命令行参数、添加默认值等。下面就直接看 kube-proxy 的 `run()` 方法：

- 若启动时指定了 `--write-config-to` 参数，kube-proxy 只将启动的默认参数写到指定的配置文件中，然后退出
- 初始化 ProxyServer 对象
- 如果启动参数 `--cleanup` 设置为 true，则清理 iptables 和 ipvs 规则并退出

`k8s.io/kubernetes/cmd/kube-proxy/app/server.go:290`

```
func (o *Options) Run() error {
    defer close(o.errCh)
    // 1.如果指定了 --write-config-to 参数，则将默认的配置文件写到指定文件并退出
    if len(o.WriteConfigTo) > 0 {
        return o.writeConfigFile()
    }

    // 2.初始化 ProxyServer 对象
    proxyServer, err := NewProxyServer(o)
    if err != nil {
        return err
    }

    // 3.如果启动参数 --cleanup 设置为 true，则清理 iptables 和 ipvs 规则并退出
    if o.CleanupAndExit {
        return proxyServer.CleanupAndExit()
    }

    o.proxyServer = proxyServer
    return o.runLoop()
}
```

`Run()` 方法中主要调用了 `NewProxyServer()` 方法来初始化 ProxyServer，然后会调用 `runLoop()` 启动主循环，继续看初始化 ProxyServer 的具体实现：

- 初始化 iptables、ipvs 相关的 interface
- 若启用了 ipvs 则检查内核版本、ipvs 依赖的内核模块、ipset 版本，内核模块主要包括：`ip_vs`，`ip_vs_rr`,`ip_vs_wrr`,`ip_vs_sh`,`nf_conntrack_ipv4`,`nf_conntrack`，若没有相关模块，kube-proxy 会尝试使用 `modprobe` 自动加载
- 根据 proxyMode 初始化 proxier，kube-proxy 启动后只运行一种 proxier

`k8s.io/kubernetes/cmd/kube-proxy/app/server_others.go:57`

```
func NewProxyServer(o *Options) (*ProxyServer, error) {
    return newProxyServer(o.config, o.CleanupAndExit, o.master)
}

func newProxyServer(
    config *proxyconfigapi.KubeProxyConfiguration,
    cleanupAndExit bool,
    master string) (*ProxyServer, error) {
    ......

    if c, err := configz.New(proxyconfigapi.GroupName); err == nil {
        c.Set(config)
    } else {
        return nil, fmt.Errorf("unable to register configz: %s", err)
    }

    ......

    // 1.关键依赖工具 iptables/ipvs/ipset/dbus
    var iptInterface utiliptables.Interface
    var ipvsInterface utilipvs.Interface
    var kernelHandler ipvs.KernelHandler
    var ipsetInterface utilipset.Interface
    var dbus utildbus.Interface

    // 2.执行 linux 命令行的工具
    execer := exec.New()

    // 3.初始化 iptables/ipvs/ipset/dbus 对象
    dbus = utildbus.New()
    iptInterface = utiliptables.New(execer, dbus, protocol)
    kernelHandler = ipvs.NewLinuxKernelHandler()
    ipsetInterface = utilipset.New(execer)

    // 4.检查该机器是否支持使用 ipvs 模式
    canUseIPVS, _ := ipvs.CanUseIPVSProxier(kernelHandler, ipsetInterface)
    if canUseIPVS {
        ipvsInterface = utilipvs.New(execer)
    }

    if cleanupAndExit {
        return &ProxyServer{
            ......
        }, nil
    }

    // 5.初始化 kube client 和 event client
    client, eventClient, err := createClients(config.ClientConnection, master)
    if err != nil {
        return nil, err
    }
    ......

    // 6.初始化 healthzServer
    var healthzServer *healthcheck.HealthzServer
    var healthzUpdater healthcheck.HealthzUpdater
    if len(config.HealthzBindAddress) > 0 {
        healthzServer = healthcheck.NewDefaultHealthzServer(config.HealthzBindAddress, 2*config.IPTables.SyncPeriod.Duration, recorder, nodeRef)
        healthzUpdater = healthzServer
    }

    // 7.proxier 是一个 interface，每种模式都是一个 proxier
    var proxier proxy.Provider

    // 8.根据 proxyMode 初始化 proxier
    proxyMode := getProxyMode(string(config.Mode), kernelHandler, ipsetInterface, iptables.LinuxKernelCompatTester{})
    ......

    if proxyMode == proxyModeIPTables {
        klog.V(0).Info("Using iptables Proxier.")
        if config.IPTables.MasqueradeBit == nil {
            return nil, fmt.Errorf("unable to read IPTables MasqueradeBit from config")
        }

        // 9.初始化 iptables 模式的 proxier
        proxier, err = iptables.NewProxier(
            .......
        )
        if err != nil {
            return nil, fmt.Errorf("unable to create proxier: %v", err)
        }
        metrics.RegisterMetrics()
    } else if proxyMode == proxyModeIPVS {
        // 10.判断是够启用了 ipv6 双栈
        if utilfeature.DefaultFeatureGate.Enabled(features.IPv6DualStack) {
            ......
            // 11.初始化 ipvs 模式的 proxier
            proxier, err = ipvs.NewDualStackProxier(
                ......
            )
        } else {
            proxier, err = ipvs.NewProxier(
                ......
            )
        }
        if err != nil {
            return nil, fmt.Errorf("unable to create proxier: %v", err)
        }
        metrics.RegisterMetrics()
    } else {
        // 12.初始化 userspace 模式的 proxier
        proxier, err = userspace.NewProxier(
            ......
        )
        if err != nil {
            return nil, fmt.Errorf("unable to create proxier: %v", err)
        }
    }

    iptInterface.AddReloadFunc(proxier.Sync)
    return &ProxyServer{
        ......
    }, nil
}
```



`runLoop()`  方法主要是启动 proxyServer。

`k8s.io/kubernetes/cmd/kube-proxy/app/server.go:311`

```
func (o *Options) runLoop() error {
	// 1.watch 配置文件变化
    if o.watcher != nil {
        o.watcher.Run()
    }

    // 2.以 goroutine 方式启动 proxyServer
    go func() {
        err := o.proxyServer.Run()
        o.errCh <- err
    }()

    for {
        err := <-o.errCh
        if err != nil {
            return err
        }
    }
}
```

`o.proxyServer.Run()`   中会启动已经初始化好的所有服务：

- 设定进程 OOMScore，可通过命令行配置，默认值为 `--oom-score-adj="-999"`
- 启动 metric server 和 healthz server，两者分别监听 10256 和 10249 端口
- 设置内核参数 `nf_conntrack_tcp_timeout_established` 和 `nf_conntrack_tcp_timeout_close_wait`
- 将 proxier 注册到 serviceEventHandler、endpointsEventHandler 中
- 启动 informer 监听 service 和 endpoints 变化
- 执行 `s.Proxier.SyncLoop()`，启动 proxier 主循环



`k8s.io/kubernetes/cmd/kube-proxy/app/server.go:527`

```
func (s *ProxyServer) Run() error {
    ......

    // 1.进程 OOMScore，避免进程因 oom 被杀掉，此处默认值为 -999
    var oomAdjuster *oom.OOMAdjuster
    if s.OOMScoreAdj != nil {
        oomAdjuster = oom.NewOOMAdjuster()
        if err := oomAdjuster.ApplyOOMScoreAdj(0, int(*s.OOMScoreAdj)); err != nil {
            klog.V(2).Info(err)
        }
    }
    ......

    // 2.启动 healthz server
    if s.HealthzServer != nil {
        s.HealthzServer.Run()
    }

    // 3.启动 metrics server
    if len(s.MetricsBindAddress) > 0 {
        ......
        go wait.Until(func() {
            err := http.ListenAndServe(s.MetricsBindAddress, proxyMux)
            if err != nil {
                utilruntime.HandleError(fmt.Errorf("starting metrics server failed: %v", err))
            }
        }, 5*time.Second, wait.NeverStop)
    }

    // 4.配置 conntrack，设置内核参数 nf_conntrack_tcp_timeout_established 和 nf_conntrack_tcp_timeout_close_wait
    if s.Conntracker != nil {
        max, err := getConntrackMax(s.ConntrackConfiguration)
        if err != nil {
            return err
        }
        if max > 0 {
            err := s.Conntracker.SetMax(max)
            ......
        }

        if s.ConntrackConfiguration.TCPEstablishedTimeout != nil && s.ConntrackConfiguration.TCPEstablishedTimeout.Duration > 0 {
            timeout := int(s.ConntrackConfiguration.TCPEstablishedTimeout.Duration / time.Second)
            if err := s.Conntracker.SetTCPEstablishedTimeout(timeout); err != nil {
                return err
            }
        }
        if s.ConntrackConfiguration.TCPCloseWaitTimeout != nil && s.ConntrackConfiguration.TCPCloseWaitTimeout.Duration > 0 {
            timeout := int(s.ConntrackConfiguration.TCPCloseWaitTimeout.Duration / time.Second)
            if err := s.Conntracker.SetTCPCloseWaitTimeout(timeout); err != nil {
                return err
            }
        }
    }

    ......

    // 5.启动 informer 监听 Services 和 Endpoints 或者 EndpointSlices 信息
    informerFactory := informers.NewSharedInformerFactoryWithOptions(s.Client, s.ConfigSyncPeriod,
        informers.WithTweakListOptions(func(options *metav1.ListOptions) {
            options.LabelSelector = labelSelector.String()
        }))


    // 6.将 proxier 注册到 serviceConfig、endpointsConfig 中
    serviceConfig := config.NewServiceConfig(informerFactory.Core().V1().Services(), s.ConfigSyncPeriod)
    serviceConfig.RegisterEventHandler(s.Proxier)
    go serviceConfig.Run(wait.NeverStop)

    if utilfeature.DefaultFeatureGate.Enabled(features.EndpointSlice) {
        endpointSliceConfig := config.NewEndpointSliceConfig(informerFactory.Discovery().V1alpha1().EndpointSlices(), s.ConfigSyncPeriod)
        endpointSliceConfig.RegisterEventHandler(s.Proxier)
        go endpointSliceConfig.Run(wait.NeverStop)
    } else {
        endpointsConfig := config.NewEndpointsConfig(informerFactory.Core().V1().Endpoints(), s.ConfigSyncPeriod)
        endpointsConfig.RegisterEventHandler(s.Proxier)
        go endpointsConfig.Run(wait.NeverStop)
    }

    // 7.启动 informer
    informerFactory.Start(wait.NeverStop)

    s.birthCry()

    // 8.启动 proxier 主循环
    s.Proxier.SyncLoop()
    return nil
}
```

回顾一下整个启动逻辑：

```
o.Run() --> o.runLoop() --> o.proxyServer.Run() --> s.Proxier.SyncLoop()
```

`o.Run()` 中调用了 `NewProxyServer()` 来初始化 proxyServer 对象，其中包括初始化每种模式对应的 proxier，该方法最终会调用 `s.Proxier.SyncLoop()` 执行 proxier 的主循环。



## proxier 的初始化

看完了启动流程的逻辑代码，接着再看一下各代理模式的初始化，上文已经提到每种模式都是一个 proxier，即要实现 `proxy.Provider` 对应的 interface，如下所示：

```
type Provider interface {
    config.EndpointsHandler
    config.EndpointSliceHandler
    config.ServiceHandler

    Sync()
    SyncLoop()
}
```

首先要实现 service、endpoints 和 endpointSlice 对应的 handler，也就是对 `OnAdd`、`OnUpdate`、`OnDelete` 、`OnSynced` 四种方法的处理，详细的代码在下文进行讲解。EndpointSlice 是在 v1.16 中新加入的一个 API。`Sync()` 和 `SyncLoop()` 是主要用来处理iptables 规则的方法。



### iptables proxier 初始化

首先看 iptables 模式的 `NewProxier()`方法，其函数的具体执行逻辑为：

- 设置相关的内核参数`route_localnet`、`bridge-nf-call-iptables`
- 生成 masquerade 标记
- 设置默认调度算法 rr
- 初始化 proxier 对象
- 使用 `BoundedFrequencyRunner` 初始化 proxier.syncRunner，将 proxier.syncProxyRules 方法注入，`BoundedFrequencyRunner` 是一个管理器用于执行用户注入的函数，可以指定运行的时间策略。



`k8s.io/kubernetes/pkg/proxy/iptables/proxier.go:249`

```
func NewProxier(ipt utiliptables.Interface,
    ......
) (*Proxier, error) {
    // 1.设置相关的内核参数
    if val, _ := sysctl.GetSysctl(sysctlRouteLocalnet); val != 1 {
        ......
    }

    if val, err := sysctl.GetSysctl(sysctlBridgeCallIPTables); err == nil && val != 1 {
        ......
    }

    // 2.设置 masqueradeMark，默认为 0x00004000/0x00004000
    // 用来标记 k8s 管理的报文，masqueradeBit 默认为 14
    // 标记 0x4000 的报文（即 POD 发出的报文)，在离开 Node 的时候需要进行 SNAT 转换
    masqueradeValue := 1 << uint(masqueradeBit)
    masqueradeMark := fmt.Sprintf("%#08x/%#08x", masqueradeValue, masqueradeValue)

    ......

    endpointSlicesEnabled := utilfeature.DefaultFeatureGate.Enabled(features.EndpointSlice)

    healthChecker := healthcheck.NewServer(hostname, recorder, nil, nil)

    // 3.初始化 proxier
    isIPv6 := ipt.IsIpv6()
    proxier := &Proxier{
        ......
    }
    burstSyncs := 2

    // 4.初始化 syncRunner，BoundedFrequencyRunner 是一个定时执行器，会定时执行
    // proxier.syncProxyRules 方法,syncProxyRules 是每个 proxier 实际刷新iptables 规则的方法
    proxier.syncRunner = async.NewBoundedFrequencyRunner("sync-runner", proxier.syncProxyRules, minSyncPeriod, syncPeriod, burstSyncs)
    return proxier, nil
}
```



### ipvs proxier 初始化

ipvs `NewProxier()` 方法主要逻辑为：

- 设定内核参数，`route_localnet`、`br_netfilter`、`bridge-nf-call-iptables`、`conntrack`、`conn_reuse_mode`、`ip_forward`、`arp_ignore`、`arp_announce` 等
- 和 iptables 一样，对于 SNAT iptables 规则生成 masquerade 标记
- 设置默认调度算法 rr
- 初始化 proxier 对象
- 初始化 ipset 规则
- 初始化 syncRunner 将 proxier.syncProxyRules 方法注入
- 启动 `gracefuldeleteManager` 定时清理 RS (realServer) 记录



`k8s.io/kubernetes/pkg/proxy/ipvs/proxier.go:316`

```
func NewProxier(ipt utiliptables.Interface,
	......
) (*Proxier, error) {

	// 1.设定内核参数
	if val, _ := sysctl.GetSysctl(sysctlRouteLocalnet); val != 1 {
        ......
	}
    ......

	// 2.生成 masquerade 标记
	masqueradeValue := 1 << uint(masqueradeBit)
	masqueradeMark := fmt.Sprintf("%#08x/%#08x", masqueradeValue, masqueradeValue)

	// 3.设置默认调度算法 rr
	if len(scheduler) == 0 {
        scheduler = DefaultScheduler
	}

	healthChecker := healthcheck.NewServer(hostname, recorder, nil, nil) // use default implementations of deps

	endpointSlicesEnabled := utilfeature.DefaultFeatureGate.Enabled(features.EndpointSlice)

	// 4.初始化 proxier
	proxier := &Proxier{
        ......
	}
	// 5.初始化 ipset 规则
	proxier.ipsetList = make(map[string]*IPSet)
	for _, is := range ipsetInfo {
        proxier.ipsetList[is.name] = NewIPSet(ipset, is.name, is.setType, isIPv6, is.comment)
	}
	burstSyncs := 2
	
    // 6.初始化 syncRunner
	proxier.syncRunner = async.NewBoundedFrequencyRunner("sync-runner", proxier.syncProxyRules, minSyncPeriod, syncPeriod, burstSyncs)
	
    // 7.启动 gracefuldeleteManager
	proxier.gracefuldeleteManager.Run()
	return proxier, nil
}
```



### userspace proxier 初始化

userspace `NewProxier()` 方法主要逻辑为：

- 初始化 iptables 规则
- 初始化 proxier
- 初始化 syncRunner 将 proxier.syncProxyRules 方法注入



`k8s.io/kubernetes/pkg/proxy/userspace/proxier.go:187`

```
func NewProxier(......) (*Proxier, error) {
    return NewCustomProxier(loadBalancer, listenIP, iptables, exec, pr, syncPeriod, minSyncPeriod, udpIdleTimeout, nodePortAddresses, newProxySocket)
}

func NewCustomProxier(......) (*Proxier, error) {
    ......

	// 1.设置打开文件数
	err = setRLimit(64 * 1000)
	if err != nil {
        return nil, fmt.Errorf("failed to set open file handler limit: %v", err)
	}

	proxyPorts := newPortAllocator(pr)

	return createProxier(loadBalancer, listenIP, iptables, exec, hostIP, proxyPorts, syncPeriod, minSyncPeriod, udpIdleTimeout, makeProxySocket)
}

func createProxier(loadBalancer LoadBalancer, listenIP net.IP, iptables iptables.Interface, exec utilexec.Interface, hostIP net.IP, proxyPorts PortAllocator, syncPeriod, minSyncPeriod, udpIdleTimeout time.Duration, makeProxySocket ProxySocketFunc) (*Proxier, error) {
	if proxyPorts == nil {
		proxyPorts = newPortAllocator(utilnet.PortRange{})
	}

	// 2.初始化 iptables 规则
	if err := iptablesInit(iptables); err != nil {
        return nil, fmt.Errorf("failed to initialize iptables: %v", err)
	}

	if err := iptablesFlush(iptables); err != nil {
        return nil, fmt.Errorf("failed to flush iptables: %v", err)
	}

	// 3.初始化 proxier
	proxier := &Proxier{
        ......
	}

	// 4.初始化 syncRunner
	proxier.syncRunner = async.NewBoundedFrequencyRunner("userspace-proxy-sync-runner", proxier.syncProxyRules, minSyncPeriod, syncPeriod, numBurstSyncs)
	return proxier, nil
}
```



## proxier 接口实现


### handler 的实现

上文已经提到过每种 proxier 都需要实现 interface 中的几个方法，首先看一下 `ServiceHandler`、`EndpointsHandler` 和 `EndpointSliceHandler` 相关的，对于 service、endpoints 和 endpointSlices 三种对象都实现了 `OnAdd`、`OnUpdate`、`OnDelete` 和 `OnSynced` 方法。

```
// 1.service 相关的方法
func (proxier *Proxier) OnServiceAdd(service *v1.Service) {
    proxier.OnServiceUpdate(nil, service)
}

func (proxier *Proxier) OnServiceUpdate(oldService, service *v1.Service) {
    if proxier.serviceChanges.Update(oldService, service) && proxier.isInitialized() {
        proxier.syncRunner.Run()
    }
}

func (proxier *Proxier) OnServiceDelete(service *v1.Service) {
    proxier.OnServiceUpdate(service, nil)
}

func (proxier *Proxier) OnServiceSynced(){
	......
	proxier.syncProxyRules()
}

// 2.endpoints 相关的方法
func (proxier *Proxier) OnEndpointsAdd(endpoints *v1.Endpoints) {
    proxier.OnEndpointsUpdate(nil, endpoints)
}

func (proxier *Proxier) OnEndpointsUpdate(oldEndpoints, endpoints *v1.Endpoints) {
    if proxier.endpointsChanges.Update(oldEndpoints, endpoints) && proxier.isInitialized() {
        proxier.Sync()
    }
}

func (proxier *Proxier) OnEndpointsDelete(endpoints *v1.Endpoints) {
    proxier.OnEndpointsUpdate(endpoints, nil)
}

func (proxier *Proxier) OnEndpointsSynced() {
	......
	proxier.syncProxyRules()
}

// 3.endpointSlice 相关的方法
func (proxier *Proxier) OnEndpointSliceAdd(endpointSlice *discovery.EndpointSlice) {
    if proxier.endpointsChanges.EndpointSliceUpdate(endpointSlice, false) && proxier.isInitialized() {
        proxier.Sync()
    }
}

func (proxier *Proxier) OnEndpointSliceUpdate(_, endpointSlice *discovery.EndpointSlice) {
    if proxier.endpointsChanges.EndpointSliceUpdate(endpointSlice, false) && proxier.isInitialized() {
        proxier.Sync()
    }
}

func (proxier *Proxier) OnEndpointSliceDelete(endpointSlice *discovery.EndpointSlice) {
    if proxier.endpointsChanges.EndpointSliceUpdate(endpointSlice, true) && proxier.isInitialized() {
        proxier.Sync()
    }
}

func (proxier *Proxier) OnEndpointSlicesSynced() {
    ......
    proxier.syncProxyRules()
}
```

在启动逻辑的 `Run()` 方法中 proxier 已经被注册到了 serviceConfig、endpointsConfig、endpointSliceConfig 中，当启动 informer，cache 同步完成后会调用 `OnSynced()`  方法，之后当 watch 到变化后会调用 proxier 中对应的 `OnUpdate()` 方法进行处理，`OnSynced()` 会直接调用 `proxier.syncProxyRules()` 来刷新iptables 规则，而 `OnUpdate()` 会调用 `proxier.syncRunner.Run()` 方法，其最终也是调用 `proxier.syncProxyRules()` 方法刷新规则的，这种转换是在 `BoundedFrequencyRunner` 中体现出来的，下面看一下具体实现。



### Sync() 以及 SyncLoop() 的实现

每种 proxier 的 `Sync()` 以及 `SyncLoop()` 方法如下所示，都是调用 syncRunner 中的相关方法，而 syncRunner  在前面的 `NewProxier()` 中已经说过了，syncRunner 是调用 `async.NewBoundedFrequencyRunner()`  方法初始化，至此，基本上可以确定了所有的核心都是在 `BoundedFrequencyRunner` 中实现的。

```
func NewProxier() (*Proxier, error) {
    ......
    proxier.syncRunner = async.NewBoundedFrequencyRunner("sync-runner", proxier.syncProxyRules, minSyncPeriod, syncPeriod, burstSyncs)
    ......
}

// Sync()
func (proxier *Proxier) Sync() {
    proxier.syncRunner.Run()
}

// SyncLoop()
func (proxier *Proxier) SyncLoop() {
    if proxier.healthzServer != nil {
        proxier.healthzServer.UpdateTimestamp()
    }
    proxier.syncRunner.Loop(wait.NeverStop)
}
```



`NewBoundedFrequencyRunner()`是其初始化的函数，其中的参数 `minInterval`和 `maxInterval` 分别对应 proxier 中的 `minSyncPeriod` 和 `syncPeriod`，两者的默认值分别为 0s 和 30s，其值可以使用 `--iptables-min-sync-period` 和  `--iptables-sync-period` 启动参数来指定。

`k8s.io/kubernetes/pkg/util/async/bounded_frequency_runner.go:134`

```
func NewBoundedFrequencyRunner(name string, fn func(), minInterval, maxInterval time.Duration, burstRuns int) *BoundedFrequencyRunner {
	timer := realTimer{Timer: time.NewTimer(0)}
	// 执行定时器
	<-timer.C()
    // 调用 construct() 函数
	return construct(name, fn, minInterval, maxInterval, burstRuns, timer)
}

func construct(name string, fn func(), minInterval, maxInterval time.Duration, burstRuns int, timer timer) *BoundedFrequencyRunner {
	if maxInterval < minInterval {
        panic(fmt.Sprintf("%s: maxInterval (%v) must be >= minInterval (%v)", name, maxInterval, minInterval))
	}
	if timer == nil {
        panic(fmt.Sprintf("%s: timer must be non-nil", name))
	}

	bfr := &BoundedFrequencyRunner{
		name:        name,
		fn:          fn,               // 被调用的函数，proxier.syncProxyRules
		minInterval: minInterval,
		maxInterval: maxInterval,
		run:         make(chan struct{}, 1),
		timer:       timer,
	}
	// 由于默认的 minInterval = 0，此处使用 nullLimiter
	if minInterval == 0 {
		bfr.limiter = nullLimiter{}
	} else {
		// 采用“令牌桶”算法实现流控机制
		qps := float32(time.Second) / float32(minInterval)
		bfr.limiter = flowcontrol.NewTokenBucketRateLimiterWithClock(qps, burstRuns, timer)
	}
	return bfr
}
```



在启动流程 `Run()` 方法最后调用的 `s.Proxier.SyncLoop()` 最终调用的是 `BoundedFrequencyRunner` 的 `Loop() `方法，如下所示：

`k8s.io/kubernetes/pkg/util/async/bounded_frequency_runner.go:169`

```
func (bfr *BoundedFrequencyRunner) Loop(stop <-chan struct{}) {
    bfr.timer.Reset(bfr.maxInterval)
    for {
        select {
        case <-stop:
            bfr.stop()
            return
        case <-bfr.timer.C():   // 定时器
            bfr.tryRun()
        case <-bfr.run:       // 接收 channel
            bfr.tryRun()
        }
    }
}
```



proxier 的 `OnUpdate()` 中调用的 `syncRunner.Run()`  其实只是在 bfr.run 这个带 buffer 的 channel 中发送了一条数据，在 `BoundedFrequencyRunner` 的 `Loop()`方法中接收到该数据后会调用 `bfr.tryRun()` 进行处理：

`k8s.io/kubernetes/pkg/util/async/bounded_frequency_runner.go:191`

```
func (bfr *BoundedFrequencyRunner) Run() {
    select {
    case bfr.run <- struct{}{}:   // 向 channel 发送信号
    default:
    }
}
```



而 `tryRun()` 方法才是最终调用 `syncProxyRules()` 刷新iptables 规则的。

`k8s.io/kubernetes/pkg/util/async/bounded_frequency_runner.go:211`

```
func (bfr *BoundedFrequencyRunner) tryRun() {
    bfr.mu.Lock()
    defer bfr.mu.Unlock()

    if bfr.limiter.TryAccept() {
        // 执行 fn() 即 syncProxyRules() 刷新iptables 规则
        bfr.fn()
        bfr.lastRun = bfr.timer.Now()
        bfr.timer.Stop()
        bfr.timer.Reset(bfr.maxInterval)
        return
    }

    elapsed := bfr.timer.Since(bfr.lastRun)    // how long since last run
    nextPossible := bfr.minInterval - elapsed  // time to next possible run
    nextScheduled := bfr.maxInterval - elapsed // time to next periodic run

    if nextPossible < nextScheduled {
        bfr.timer.Stop()
        bfr.timer.Reset(nextPossible)
    }
}
```



通过以上分析可知，`syncProxyRules()` 是每个 proxier 的核心方法，启动 informer cache 同步完成后会直接调用 `proxier.syncProxyRules()` 刷新iptables 规则，之后如果 informer watch 到相关对象的变化后会调用 `BoundedFrequencyRunner` 的 `tryRun()`来刷新iptables 规则，定时器每 30s 会执行一次iptables 规则的刷新。



## 总结

本文主要介绍了 kube-proxy 的启动逻辑以及三种模式 proxier 的初始化，还有最终调用刷新iptables 规则的 BoundedFrequencyRunner，可以看到其中的代码写的很巧妙。而每种模式下的iptables 规则是如何创建、刷新以及转发的是如何实现的会在后面的文章中进行分析。
