---
title: kubernets 中事件处理机制
date: 2019-02-26 20:49:30
tags: ["events","kubelet"]
type: "k8s-events"

---

当集群中的 node 或 pod 异常时，大部分用户会使用 kubectl 查看对应的 events，那么 events 是从何而来的？其实 k8s 中的各个组件会将运行时产生的各种事件汇报到 apiserver，对于 k8s 中的可描述资源，使用 kubectl describe 都可以看到其相关的 events，那 k8s 中又有哪几个组件都上报 events 呢？ 

只要在 `k8s.io/kubernetes/cmd` 目录下暴力搜索一下就能知道哪些组件会产生 events：
```
$ grep -R -n -i "EventRecorder" .
```

可以看出，controller-manage、kube-proxy、kube-scheduler、kubelet 都使用了 EventRecorder，本文只讲述 kubelet 中对 Events 的使用。



##### 1、Events 的定义

events 在 `k8s.io/api/core/v1/types.go` 中进行定义,结构体如下所示：

```
type Event struct {
    metav1.TypeMeta `json:",inline"`
    metav1.ObjectMeta `json:"metadata" protobuf:"bytes,1,opt,name=metadata"`
    InvolvedObject ObjectReference `json:"involvedObject" protobuf:"bytes,2,opt,name=involvedObject"`
    Reason string `json:"reason,omitempty" protobuf:"bytes,3,opt,name=reason"`
    Message string `json:"message,omitempty" protobuf:"bytes,4,opt,name=message"`
    Source EventSource `json:"source,omitempty" protobuf:"bytes,5,opt,name=source"`
    FirstTimestamp metav1.Time `json:"firstTimestamp,omitempty" protobuf:"bytes,6,opt,name=firstTimestamp"`
    LastTimestamp metav1.Time `json:"lastTimestamp,omitempty" protobuf:"bytes,7,opt,name=lastTimestamp"`
    Count int32 `json:"count,omitempty" protobuf:"varint,8,opt,name=count"`
    Type string `json:"type,omitempty" protobuf:"bytes,9,opt,name=type"`
    EventTime metav1.MicroTime `json:"eventTime,omitempty" protobuf:"bytes,10,opt,name=eventTime"`
    Series *EventSeries `json:"series,omitempty" protobuf:"bytes,11,opt,name=series"`
    Action string `json:"action,omitempty" protobuf:"bytes,12,opt,name=action"`
    Related *ObjectReference `json:"related,omitempty" protobuf:"bytes,13,opt,name=related"`
    ReportingController string `json:"reportingComponent" protobuf:"bytes,14,opt,name=reportingComponent"`
    ReportingInstance string `json:"reportingInstance" protobuf:"bytes,15,opt,name=reportingInstance"`
    ReportingInstance string `json:"reportingInstance" protobuf:"bytes,15,opt,name=reportingInstance"`
}
```

其中 InvolvedObject 代表和事件关联的对象，source 代表事件源，使用 kubectl 看到的事件一般包含 Type、Reason、Age、From、Message 几个字段。

k8s 中 events 目前只有两种类型："Normal" 和 "Warning"：

![events 的两种类型](http://cdn.tianfeiyu.com/events.png)


##### 2、EventBroadcaster 的初始化

events 的整个生命周期都与 EventBroadcaster 有关，kubelet 中对 EventBroadcaster 的初始化在`k8s.io/kubernetes/cmd/kubelet/app/server.go`中：


```
func RunKubelet(kubeServer *options.KubeletServer, kubeDeps *kubelet.Dependencies, runOnce bool) error {
  ...
  // event 初始化
  makeEventRecorder(kubeDeps, nodeName)
  ...
}


func makeEventRecorder(kubeDeps *kubelet.Dependencies, nodeName types.NodeName) {
  if kubeDeps.Recorder != nil {
    return
  }
  // 初始化 EventBroadcaster 
  eventBroadcaster := record.NewBroadcaster()
  // 初始化 EventRecorder
  kubeDeps.Recorder = eventBroadcaster.NewRecorder(legacyscheme.Scheme, v1.EventSource{Component: componentKubelet, Host: string(nodeName)})
  // 记录 events 到本地日志
  eventBroadcaster.StartLogging(glog.V(3).Infof)
  if kubeDeps.EventClient != nil {
    glog.V(4).Infof("Sending events to api server.")
    // 上报 events 到 apiserver
  eventBroadcaster.StartRecordingToSink(&v1core.EventSinkImpl{Interface: kubeDeps.EventClient.Events("")})
  } else {
    glog.Warning("No api server defined - no events will be sent to API server.")
  }
}
```

Kubelet 在启动的时候会初始化一个 EventBroadcaster，它主要是对接收到的 events 做一些后续的处理(保存、上报等），EventBroadcaster 也会被 kubelet 中的其他模块使用，以下是相关的定义，对 events 生成和处理的函数都定义在 `k8s.io/client-go/tools/record/event.go` 中：

```
type eventBroadcasterImpl struct {
  *watch.Broadcaster
  sleepDuration time.Duration
}

// EventBroadcaster knows how to receive events and send them to any EventSink, watcher, or log.
type EventBroadcaster interface {
  StartEventWatcher(eventHandler func(*v1.Event)) watch.Interface

  StartRecordingToSink(sink EventSink) watch.Interface

  StartLogging(logf func(format string, args ...interface{})) watch.Interface

  NewRecorder(scheme *runtime.Scheme, source v1.EventSource) EventRecorder
}
```

EventBroadcaster 是个接口类型，该接口有以下四个方法：
- StartEventWatcher() ： EventBroadcaster 中的核心方法，接收各模块产生的 events，参数为一个处理 events 的函数，用户可以使用 StartEventWatcher() 接收 events 然后使用自定义的 handle 进行处理
- StartRecordingToSink() ： 调用 StartEventWatcher() 接收 events，并将收到的 events 发送到 apiserver 
- StartLogging() ：也是调用 StartEventWatcher() 接收 events，然后保存 events 到日志
- NewRecorder() ：会创建一个指定 EventSource 的 EventRecorder，EventSource 指明了哪个节点的哪个组件


eventBroadcasterImpl 是 eventBroadcaster 实际的对象，初始化 EventBroadcaster 对象的时候会初始化一个 Broadcaster，Broadcaster 会启动一个 goroutine 接收各组件产生的 events 并广播到每一个 watcher。

```
func NewBroadcaster() EventBroadcaster {
  return &eventBroadcasterImpl{watch.NewBroadcaster(maxQueuedEvents, watch.DropIfChannelFull), defaultSleepDuration}
}
```

可以看到，kubelet 在初始化完 EventBroadcaster 后会调用 StartRecordingToSink() 和 StartLogging() 两个方法，StartRecordingToSink() 处理函数会将收到的 events 进行缓存、过滤、聚合而后发送到 apiserver，StartLogging() 仅将 events 保存到 kubelet 的日志中。

##### 3、Events 的生成

从初始化 EventBroadcaster 的代码中可以看到 kubelet 在初始化完 EventBroadcaster 后紧接着初始化了 EventRecorder，并将已经初始化的 Broadcaster 对象作为参数传给了 EventRecorder，至此，EventBroadcaster、EventRecorder、Broadcaster 三个对象产生了关联。EventRecorder 的主要功能是生成指定格式的 events，以下是相关的定义：

```
type recorderImpl struct {
  scheme *runtime.Scheme
  source v1.EventSource
  *watch.Broadcaster
  clock clock.Clock
}

type EventRecorder interface {
  Event(object runtime.Object, eventtype, reason, message string)

  Eventf(object runtime.Object, eventtype, reason, messageFmt string, args ...interface{})

  PastEventf(object runtime.Object, timestamp metav1.Time, eventtype, reason, messageFmt string, args ...interface{})

  AnnotatedEventf(object runtime.Object, annotations map[string]string, eventtype, reason, messageFmt string, args ...interface{})
}
```

EventRecorder 中包含的几个方法都是产生指定格式的 events，Event() 和 Eventf() 的功能类似 fmt.Println() 和 fmt.Printf()，kubelet 中的各个模块会调用 EventRecorder 生成 events。recorderImpl 是 EventRecorder 实际的对象。EventRecorder 的每个方法会调用 generateEvent，在 generateEvent 中初始化 events 。

以下是生成 events 的函数：

```
func (recorder *recorderImpl) generateEvent(object runtime.Object, annotations map[string]string, timestamp metav1.Time, eventtype, reason, message string) {
  ref, err := ref.GetReference(recorder.scheme, object)
  if err != nil {
    glog.Errorf("Could not construct reference to: '%#v' due to: '%v'. Will not report event: '%v' '%v' '%v'", object, err, eventtype, reason, message)
    return
  }

  if !validateEventType(eventtype) {
    glog.Errorf("Unsupported event type: '%v'", eventtype)
    return
  }

  event := recorder.makeEvent(ref, annotations, eventtype, reason, message)
  event.Source = recorder.source

  go func() {
    // NOTE: events should be a non-blocking operation
    defer utilruntime.HandleCrash()
    // 发送事件
    recorder.Action(watch.Added, event)
  }()
}

func (recorder *recorderImpl) makeEvent(ref *v1.ObjectReference, annotations map[string]string, eventtype, reason, message string) *v1.Event {
  t := metav1.Time{Time: recorder.clock.Now()}
  namespace := ref.Namespace
  if namespace == "" {
    namespace = metav1.NamespaceDefault
  }
  return &v1.Event{
    ObjectMeta: metav1.ObjectMeta{
      Name:        fmt.Sprintf("%v.%x", ref.Name, t.UnixNano()),
      Namespace:   namespace,
      Annotations: annotations,
    },
    InvolvedObject: *ref,
    Reason:         reason,
    Message:        message,
    FirstTimestamp: t,
    LastTimestamp:  t,
    Count:          1,
    Type:           eventtype,
  }
}
```
初始化完 events 后会调用 recorder.Action() 将 events 发送到 Broadcaster 的事件接收队列中, Action() 是 Broadcaster 中的方法。

以下是 Action() 方法的实现：

```
func (m *Broadcaster) Action(action EventType, obj runtime.Object) {
  m.incoming <- Event{action, obj}
}
```

##### 4、Events 的广播

上面已经说了，EventBroadcaster 初始化时会初始化一个 Broadcaster，Broadcaster 的作用就是接收所有的 events 并进行广播，Broadcaster 的实现在 `k8s.io/apimachinery/pkg/watch/mux.go ` 中，Broadcaster 初始化完成后会在后台启动一个 goroutine，然后接收所有从 EventRecorder 发送过来的 events，Broadcaster 中有一个 map 会保存每一个注册的 watcher， 接着将 events 广播给所有的 watcher，每个 watcher 都有一个接收消息的 channel，watcher 可以通过它的 ResultChan() 方法从 channel 中读取数据进行消费。


以下是 Broadcaster 广播 events 的实现：
```
func (m *Broadcaster) loop() {
  for event := range m.incoming {
    if event.Type == internalRunFunctionMarker {
      event.Object.(functionFakeRuntimeObject)()
      continue
    }
    m.distribute(event)
  }
  m.closeAll()
  m.distributing.Done()
}

// distribute sends event to all watchers. Blocking.
func (m *Broadcaster) distribute(event Event) {
  m.lock.Lock()
  defer m.lock.Unlock()
  if m.fullChannelBehavior == DropIfChannelFull {
    for _, w := range m.watchers {
      select {
      case w.result <- event:
      case <-w.stopped:
      default: // Don't block if the event can't be queued.
      }
    }
  } else {
    for _, w := range m.watchers {
      select {
      case w.result <- event:
      case <-w.stopped:
      }
    }
  }
}
```


##### 5、Events 的处理

那么 watcher 是从何而来呢？每一个要处理 events 的 client 都需要初始化一个 watcher，处理 events 的方法是在 EventBroadcaster 中定义的，以下是 EventBroadcaster 中对 events 处理的三个函数：

```
func (eventBroadcaster *eventBroadcasterImpl) StartEventWatcher(eventHandler func(*v1.Event)) watch.Interface {
  watcher := eventBroadcaster.Watch()
  go func() {
    defer utilruntime.HandleCrash()
    for watchEvent := range watcher.ResultChan() {
      event, ok := watchEvent.Object.(*v1.Event)
      if !ok {
        // This is all local, so there's no reason this should
        // ever happen.
        continue
      }
      eventHandler(event)
    }
  }()
  return watcher
}
```

StartEventWatcher() 首先实例化一个 watcher，每个 watcher 都会被塞入到 Broadcaster 的 watcher 列表中，watcher 从 Broadcaster 提供的 channel 中读取 events，然后再调用 eventHandler 进行处理，StartLogging() 和 StartRecordingToSink() 都是对 StartEventWatcher() 的封装，都会传入自己的处理函数。



```
func (eventBroadcaster *eventBroadcasterImpl) StartLogging(logf func(format string, args ...interface{})) watch.Interface {
  return eventBroadcaster.StartEventWatcher(
    func(e *v1.Event) {
      logf("Event(%#v): type: '%v' reason: '%v' %v", e.InvolvedObject, e.Type, e.Reason, e.Message)
    })
}
```

StartLogging() 传入的 eventHandler 仅将 events 保存到日志中。

```
func (eventBroadcaster *eventBroadcasterImpl) StartRecordingToSink(sink EventSink) watch.Interface {
  // The default math/rand package functions aren't thread safe, so create a
  // new Rand object for each StartRecording call.
  randGen := rand.New(rand.NewSource(time.Now().UnixNano()))
  eventCorrelator := NewEventCorrelator(clock.RealClock{})
  return eventBroadcaster.StartEventWatcher(
    func(event *v1.Event) {
      recordToSink(sink, event, eventCorrelator, randGen, eventBroadcaster.sleepDuration)
    })
}

func recordToSink(sink EventSink, event *v1.Event, eventCorrelator *EventCorrelator, randGen *rand.Rand, sleepDuration time.Duration) {
  eventCopy := *event
  event = &eventCopy
  result, err := eventCorrelator.EventCorrelate(event)
  if err != nil {
    utilruntime.HandleError(err)
  }
  if result.Skip {
    return
  }
  tries := 0
  for {
    if recordEvent(sink, result.Event, result.Patch, result.Event.Count > 1, eventCorrelator) {
      break
    }
    tries++
    if tries >= maxTriesPerEvent {
      glog.Errorf("Unable to write event '%#v' (retry limit exceeded!)", event)
      break
    }
    // 第一次重试增加随机性，防止 apiserver 重启的时候所有的事件都在同一时间发送事件
    if tries == 1 {
      time.Sleep(time.Duration(float64(sleepDuration) * randGen.Float64()))
    } else {
      time.Sleep(sleepDuration)
    }
  }
}
```

StartRecordingToSink() 方法先根据当前时间生成一个随机数发生器 randGen，增加随机数是为了在重试时增加随机性，防止 apiserver 重启的时候所有的事件都在同一时间发送事件，接着实例化一个EventCorrelator，EventCorrelator 会对事件做一些预处理的工作，其中包括过滤、聚合、缓存等操作，具体代码不做详细分析，最后将 recordToSink() 函数作为处理函数，recordToSink() 会将处理后的 events 发送到 apiserver，这是 StartEventWatcher() 的整个工作流程。


##### 6、Events 简单实现

了解完 events 的整个处理流程后，可以参考其实现方式写一个 demo，要实现一个完整的 events 需要包含以下几个功能：

- 1、事件的产生
- 2、事件的发送
- 3、事件广播
- 4、事件缓存
- 5、事件过滤和聚合

```
package main

import (
  "fmt"
  "sync"
  "time"
)

// watcher queue
const queueLength = int64(1)

// Events xxx
type Events struct {
  Reason    string
  Message   string
  Source    string
  Type      string
  Count     int64
  Timestamp time.Time
}

// EventBroadcaster xxx
type EventBroadcaster interface {
  Event(etype, reason, message string)
  StartLogging() Interface
  Stop()
}

// eventBroadcaster xxx
type eventBroadcasterImpl struct {
  *Broadcaster
}

func NewEventBroadcaster() EventBroadcaster {
  return &eventBroadcasterImpl{NewBroadcaster(queueLength)}
}

func (eventBroadcaster *eventBroadcasterImpl) Stop() {
  eventBroadcaster.Shutdown()
}

// generate event
func (eventBroadcaster *eventBroadcasterImpl) Event(etype, reason, message string) {
  events := &Events{Type: etype, Reason: reason, Message: message}
  // send event to broadcast
  eventBroadcaster.Action(events)
}

// 仅实现 StartLogging() 的功能，将日志打印
func (eventBroadcaster *eventBroadcasterImpl) StartLogging() Interface {
  // register a watcher
  watcher := eventBroadcaster.Watch()
  go func() {
    for watchEvent := range watcher.ResultChan() {
      fmt.Printf("%v\n", watchEvent)
    }
  }()

  go func() {
    time.Sleep(time.Second * 4)
    watcher.Stop()
  }()

  return watcher
}

// --------------------
// Broadcaster 定义与实现
// 接收 events channel 的长度
const incomingQueuLength = 100

type Broadcaster struct {
  lock             sync.Mutex
  incoming         chan Events
  watchers         map[int64]*broadcasterWatcher
  watchersQueue    int64
  watchQueueLength int64
  distributing     sync.WaitGroup
}

func NewBroadcaster(queueLength int64) *Broadcaster {
  m := &Broadcaster{
    incoming:         make(chan Events, incomingQueuLength),
    watchers:         map[int64]*broadcasterWatcher{},
    watchQueueLength: queueLength,
  }
  m.distributing.Add(1)
  // 后台启动一个 goroutine 广播 events
  go m.loop()
  return m
}

// Broadcaster 接收所产生的 events
func (m *Broadcaster) Action(event *Events) {
  m.incoming <- *event
}

// 广播 events 到每个 watcher
func (m *Broadcaster) loop() {
  // 从 incoming channel 中读取所接收到的 events
  for event := range m.incoming {
    // 发送 events 到每一个 watcher
    for _, w := range m.watchers {
      select {
      case w.result <- event:
      case <-w.stopped:
      default:
      }
    }
  }
  m.closeAll()
  m.distributing.Done()
}

func (m *Broadcaster) Shutdown() {
  close(m.incoming)
  m.distributing.Wait()
}

func (m *Broadcaster) closeAll() {
  // TODO
  m.lock.Lock()
  defer m.lock.Unlock()
  for _, w := range m.watchers {
    close(w.result)
  }
  m.watchers = map[int64]*broadcasterWatcher{}
}

func (m *Broadcaster) stopWatching(id int64) {
  m.lock.Lock()
  defer m.lock.Unlock()
  w, ok := m.watchers[id]
  if !ok {
    return
  }
  delete(m.watchers, id)
  close(w.result)
}

// 调用 Watch(）方法注册一个 watcher
func (m *Broadcaster) Watch() Interface {
  watcher := &broadcasterWatcher{
    result:  make(chan Events, incomingQueuLength),
    stopped: make(chan struct{}),
    id:      m.watchQueueLength,
    m:       m,
  }
  m.watchers[m.watchersQueue] = watcher
  m.watchQueueLength++
  return watcher
}

// watcher 实现
type Interface interface {
  Stop()
  ResultChan() <-chan Events
}

type broadcasterWatcher struct {
  result  chan Events
  stopped chan struct{}
  stop    sync.Once
  id      int64
  m       *Broadcaster
}

// 每个 watcher 通过该方法读取 channel 中广播的 events
func (b *broadcasterWatcher) ResultChan() <-chan Events {
  return b.result
}

func (b *broadcasterWatcher) Stop() {
  b.stop.Do(func() {
    close(b.stopped)
    b.m.stopWatching(b.id)
  })
}

// --------------------

func main() {
  eventBroadcast := NewEventBroadcaster()

  var wg sync.WaitGroup
  wg.Add(1)
  // producer event
  go func() {
    defer wg.Done()
    time.Sleep(time.Second)
    eventBroadcast.Event("add", "test", "1")
    time.Sleep(time.Second * 2)
    eventBroadcast.Event("add", "test", "2")
    time.Sleep(time.Second * 3)
    eventBroadcast.Event("add", "test", "3")
    //eventBroadcast.Stop()
  }()

  eventBroadcast.StartLogging()
  wg.Wait()
}
```

此处仅简单实现，将 EventRecorder 处理 events 的功能直接放在了 EventBroadcaster 中实现，对 events 的处理方法仅实现了 StartLogging()，Broadcaster 中的部分功能是直接复制 k8s 中的代码，有一定的精简，其实现值得学习，此处对 EventCorrelator 并没有进行实现。


代码请参考：https://github.com/gosoon/k8s-learning-notes/tree/master/k8s-package/events

##### 7、总结

本文讲述了 k8s 中 events 从产生到展示的一个完整过程，最后也实现了一个简单的 demo，在此将 kubelet 对 events 的整个处理过程再梳理下，其中主要有三个对象 EventBroadcaster、EventRecorder、Broadcaster：

- 1、kubelet 首先会初始化 EventBroadcaster 对象，同时会初始化一个 Broadcaster 对象。
- 2、kubelet 通过 EventBroadcaster 对象的 NewRecorder() 方法初始化 EventRecorder 对象，EventRecorder 对象提供的几个方法会生成 events 并通过 Action() 方法发送 events 到 Broadcaster 的 channel 队列中。
- 3、Broadcaster 的作用就是接收所有的 events 并进行广播，Broadcaster 初始化后会在后台启动一个 goroutine，然后接收所有从 EventRecorder 发来的 events。
- 4、EventBroadcaster 对 events 有三个处理方法：StartEventWatcher()、StartRecordingToSink()、StartLogging()，StartEventWatcher() 是其中的核心方法，会初始化一个 watcher 注册到 Broadcaster，其余两个处理函数对 StartEventWatcher() 进行了封装，并实现了自己的处理函数。
- 5、 Broadcaster 中有一个 map 会保存每一个注册的 watcher，其会将所有的 events 广播给每一个 watcher，每个 watcher 通过它的 ResultChan() 方法从 channel 接收 events。
- 6、kubelet 会使用 StartRecordingToSink() 和 StartLogging() 对 events 进行处理，StartRecordingToSink() 处理函数收到 events 后会进行缓存、过滤、聚合而后发送到 apiserver，apiserver 会将 events 保存到 etcd 中，使用 kubectl 或其他客户端可以查看。StartLogging() 仅将 events 保存到 kubelet 的日志中。
