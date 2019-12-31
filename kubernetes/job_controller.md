---
title: job controller 源码分析
date: 2019-12-31 15:31:30
tags: ["kube-controller-manager","job controller"]
type: "job controller"

---

* [job 的基本功能](#job-的基本功能)
   * [创建](#创建)
   * [扩缩容](#扩缩容)
   * [删除](#删除)
      * [自动清理机制](#自动清理机制)
* [job controller 源码分析](#job-controller-源码分析)
   * [startJobController](#startjobcontroller)
   * [Run](#run)
   * [syncJob](#syncjob)
      * [jm.manageJob](#jmmanagejob)
* [总结](#总结)

job 在 kubernetes 中主要用来处理离线任务，job 直接管理 pod，可以创建一个或多个 pod 并会确保指定数量的 pod 运行完成。kubernetes 中有两种类型的 job，分别为 cronjob 和 batchjob，cronjob 类似于定时任务是定时触发的而 batchjob 创建后会直接运行，本文主要介绍 batchjob，下面简称为 job。


### job 的基本功能

#### 创建

job 的一个示例如下所示：

```
apiVersion: batch/v1
kind: Job
metadata:
  name: pi
spec:
  backoffLimit: 6                // 标记为 failed 前的重试次数，默认为 6
  completions: 4                 // 要完成job 的 pod 数，若没有设定该值则默认等于 parallelism 的值
  parallelism: 2                 // 任意时间最多可以启动多少个 pod 同时运行，默认为 1
  activeDeadlineSeconds: 120     // job 运行时间
  ttlSecondsAfterFinished: 60    // job 在运行完成后 60 秒就会自动删除掉
  template:
    spec:
      containers:
      - command:
        - sh
        - -c
        - 'echo ''scale=5000; 4*a(1)'' | bc -l '
        image: resouer/ubuntu-bc
        name: pi
      restartPolicy: Never
```



#### 扩缩容

job 不支持运行时扩缩容，job 在创建后其 `spec.completions` 字段也不支持修改。



#### 删除

通常系统中已执行完成的 job 不再需要，将它们保留在系统中会占用一定的资源，需要进行回收，pod 在执行完任务后会进入到 `Completed` 状态，删除 job 也会清除其创建的 pod。

```
$ kubectl get pod
pi-gdrwr                            0/1     Completed   0          10m
pi-rjphf                            0/1     Completed   0          10m

$ kubectl delete job pi
```



##### 自动清理机制

每次 job 执行完成后手动回收非常麻烦，k8s 在 v1.12 版本中加入了 `TTLAfterFinished` feature-gates，启用该特性后会启动一个 TTL 控制器，在创建 job 时指定后可在 job 运行完成后自动回收相关联的 pod，如上文中的 yaml 所示，创建 job 时指定了 `ttlSecondsAfterFinished: 60`，job 在执行完成后停留 60s 会被自动回收， 若 `ttlSecondsAfterFinished` 设置为 0 则表示在 job 执行完成后立刻回收。当 TTL 控制器清理 job 时，它将级联删除 job，即 pod 和 job 一起被删除。不过该特性截止目前还是 Alpha 版本，请谨慎使用。



### job controller 源码分析

在上节介绍了 job 的基本操作后，本节会继续深入源码了解其背后的设计与实现。

#### startJobController

首先还是直接看 jobController 的启动方法 `startJobController`，该方法中调用 `NewJobController` 初始化 jobController 然后调用 `Run` 方法启动 jobController。从初始化流程中可以看到 JobController 监听 pod 和 job 两种资源，其中 `ConcurrentJobSyncs` 默认值为 5。

`k8s.io/kubernetes/cmd/kube-controller-manager/app/batch.go:33`

```
func startJobController(ctx ControllerContext) (http.Handler, bool, error) {
    if !ctx.AvailableResources[schema.GroupVersionResource{Group: "batch", Version: "v1", Resource: "jobs"}] {
        return nil, false, nil
    }
    go job.NewJobController(
        ctx.InformerFactory.Core().V1().Pods(),
        ctx.InformerFactory.Batch().V1().Jobs(),
        ctx.ClientBuilder.ClientOrDie("job-controller"),
    ).Run(int(ctx.ComponentConfig.JobController.ConcurrentJobSyncs), ctx.Stop)
    return nil, true, nil
}
```



#### Run

以下是 jobController 的 `Run` 方法，其中核心逻辑是调用 `jm.worker` 执行 syncLoop 操作，worker 方法是 `syncJob` 方法的别名，最终调用的是 `syncJob`。

`k8s.io/kubernetes/pkg/controller/job/job_controller.go:139`

```
func (jm *JobController) Run(workers int, stopCh <-chan struct{}) {
    defer utilruntime.HandleCrash()
    defer jm.queue.ShutDown()

    klog.Infof("Starting job controller")
    defer klog.Infof("Shutting down job controller")

    if !cache.WaitForNamedCacheSync("job", stopCh, jm.podStoreSynced, jm.jobStoreSynced) {
        return
    }

    for i := 0; i < workers; i++ {
        go wait.Until(jm.worker, time.Second, stopCh)
    }

    <-stopCh
}
```



#### syncJob

`syncJob` 是 jobController 的核心方法，其主要逻辑为：
- 1、从 lister 中获取 job 对象；
- 2、判断 job 是否已经执行完成，当 job 的 `.status.conditions` 中有 `Complete` 或 `Failed` 的 type 且对应的 status 为 true 时表示该 job 已经执行完成，例如：

  ```
  status:
    completionTime: "2019-12-18T14:16:47Z"
    conditions:
    - lastProbeTime: "2019-12-18T14:16:47Z"
      lastTransitionTime: "2019-12-18T14:16:47Z"
      status: "True"				// status 为 true
      type: Complete          			// Complete
    startTime: "2019-12-18T14:15:35Z"
    succeeded: 2
  ```
- 3、获取 job 重试的次数；
- 4、调用 `jm.expectations.SatisfiedExpectations` 判断 job 是否需能进行 sync 操作，Expectations 机制在之前写的” ReplicaSetController 源码分析“一文中详细讲解过，其主要判断条件如下：
  - 1、该 key 在 ControllerExpectations 中的 adds 和 dels 都 <= 0，即调用 apiserver 的创建和删除接口没有失败过；
  - 2、该 key 在 ControllerExpectations 中已经超过 5min 没有更新了；
  - 3、该 key 在 ControllerExpectations 中不存在，即该对象是新创建的；
  - 4、调用 `GetExpectations` 方法失败，内部错误；
- 5、调用 `jm.getPodsForJob` 通过 selector 获取 job 关联的 pod，若有孤儿 pod 的 label 与 job 的能匹配则进行关联，若已关联的 pod label 有变化则解除与 job 的关联关系；
- 6、分别计算 `active`、`succeeded`、`failed` 状态的 pod 数；
- 7、判断 job 是否为首次启动，若首次启动其 `job.Status.StartTime` 为空，此时首先设置 startTime，然后检查是否有 `job.Spec.ActiveDeadlineSeconds` 是否为空，若不为空则将其再加入到延迟队列中，等待 `ActiveDeadlineSeconds` 时间后会再次触发 sync 操作；
- 8、判断 job 的重试次数是否超过了 `job.Spec.BackoffLimit`(默认是6次)，有两个判断方法一是 job 的重试次数以及 job 的状态，二是当 job 的 `restartPolicy` 为 `OnFailure` 时 container 的重启次数，两者任一个符合都说明 job 处于 failed 状态且原因为 `BackoffLimitExceeded`；
- 9、判断 job 的运行时间是否达到 `job.Spec.ActiveDeadlineSeconds` 中设定的值，若已达到则说明 job 此时处于 failed 状态且原因为 `DeadlineExceeded`；
- 10、根据以上判断如果 job 处于 failed 状态，则调用 `jm.deleteJobPods` 并发删除所有 active pods ；
- 11、若非 failed 状态，根据 ` jobNeedsSync` 判断是否要进行同步，若需要同步则调用 `jm.manageJob` 进行同步；
- 12、通过检查 `job.Spec.Completions` 判断 job 是否已经运行完成，若 `job.Spec.Completions` 字段没有设置值则只要有一个 pod 运行完成该 job 就为 `Completed` 状态，若设置了 `job.Spec.Completions` 会通过判断已经运行完成状态的 pod 即 `succeeded` pod 数是否大于等于该值；
- 13、通过以上判断若 job 运行完成了，则更新 `job.Status.Conditions` 和 `job.Status.CompletionTime` 字段；
- 14、如果 job 的 status 有变化，将 job 的 status 更新到 apiserver；



在 `syncJob` 中又调用了 `jm.manageJob` 处理非 failed 状态下的 `sync` 操作，下面主要分析一下该方法。



`k8s.io/kubernetes/pkg/controller/job/job_controller.go:436`

```
func (jm *JobController) syncJob(key string) (bool, error) {
    // 1、计算每次 sync 的运行时间
    startTime := time.Now()
    defer func() {
        klog.V(4).Infof("Finished syncing job %q (%v)", key, time.Since(startTime))
    }()

    ns, name, err := cache.SplitMetaNamespaceKey(key)
    if err != nil {
        return false, err
    }
    if len(ns) == 0 || len(name) == 0 {
        return false, fmt.Errorf("invalid job key %q: either namespace or name is missing", key)
    }

    // 2、从 lister 中获取 job 对象
    sharedJob, err := jm.jobLister.Jobs(ns).Get(name)
    if err != nil {
        if errors.IsNotFound(err) {
            klog.V(4).Infof("Job has been deleted: %v", key)
            jm.expectations.DeleteExpectations(key)
            return true, nil
        }
        return false, err
    }
    job := *sharedJob

    // 3、判断 job 是否已经执行完成
    if IsJobFinished(&job) {
        return true, nil
    }

    // 4、获取 job 重试的次数
    previousRetry := jm.queue.NumRequeues(key)

    // 5、判断 job 是否能进行 sync 操作
    jobNeedsSync := jm.expectations.SatisfiedExpectations(key)

    // 6、获取 job 关联的所有 pod
    pods, err := jm.getPodsForJob(&job)
    if err != nil {
        return false, err
    }

    // 7、分别计算 active、succeeded、failed 状态的 pod 数
    activePods := controller.FilterActivePods(pods)
    active := int32(len(activePods))
    succeeded, failed := getStatus(pods)
    conditions := len(job.Status.Conditions)

    // 8、判断 job 是否为首次启动
    if job.Status.StartTime == nil {
        now := metav1.Now()
        job.Status.StartTime = &now
        // 9、判断是否设定了 ActiveDeadlineSeconds 值
        if job.Spec.ActiveDeadlineSeconds != nil {
            klog.V(4).Infof("Job %s have ActiveDeadlineSeconds will sync after %d seconds",
                key, *job.Spec.ActiveDeadlineSeconds)
            jm.queue.AddAfter(key, time.Duration(*job.Spec.ActiveDeadlineSeconds)*time.Second)
        }
    }

    var manageJobErr error
    jobFailed := false
    var failureReason string
    var failureMessage string

    // 10、判断 job 的重启次数是否已达到上限，即处于 BackoffLimitExceeded
    jobHaveNewFailure := failed > job.Status.Failed
    exceedsBackoffLimit := jobHaveNewFailure && (active != *job.Spec.Parallelism) &&
        (int32(previousRetry)+1 > *job.Spec.BackoffLimit)

    if exceedsBackoffLimit || pastBackoffLimitOnFailure(&job, pods) {
        jobFailed = true
        failureReason = "BackoffLimitExceeded"
        failureMessage = "Job has reached the specified backoff limit"
    } else if pastActiveDeadline(&job) {
        jobFailed = true
        failureReason = "DeadlineExceeded"
        failureMessage = "Job was active longer than specified deadline"
    }

    // 11、如果处于 failed 状态，则调用 jm.deleteJobPods 并发删除所有 active pods
    if jobFailed {
        errCh := make(chan error, active)
        jm.deleteJobPods(&job, activePods, errCh)
        select {
        case manageJobErr = <-errCh:
            if manageJobErr != nil {
                break
            }
        default:
        }

        failed += active
        active = 0
        job.Status.Conditions = append(job.Status.Conditions, newCondition(batch.JobFailed, failureReason, failureMessage))
        jm.recorder.Event(&job, v1.EventTypeWarning, failureReason, failureMessage)
    } else {

        // 12、若非 failed 状态，根据 jobNeedsSync 判断是否要进行同步
        if jobNeedsSync && job.DeletionTimestamp == nil {
            active, manageJobErr = jm.manageJob(activePods, succeeded, &job)
        }

        // 13、检查 job.Spec.Completions 判断 job 是否已经运行完成
        completions := succeeded
        complete := false
        if job.Spec.Completions == nil {
            if succeeded > 0 && active == 0 {
                complete = true
            }
        } else {
            if completions >= *job.Spec.Completions {
                complete = true
                if active > 0 {
                    jm.recorder.Event(&job, v1.EventTypeWarning, "TooManyActivePods", "Too many active pods running after completion count reached")
                }
                if completions > *job.Spec.Completions {
                    jm.recorder.Event(&job, v1.EventTypeWarning, "TooManySucceededPods", "Too many succeeded pods running after completion count        reached")
                }
            }
        }

        // 14、若 job 运行完成了，则更新 job.Status.Conditions 和 job.Status.CompletionTime 字段
        if complete {
            job.Status.Conditions = append(job.Status.Conditions, newCondition(batch.JobComplete, "", ""))
            now := metav1.Now()
            job.Status.CompletionTime = &now
        }
    }

    forget := false
    if job.Status.Succeeded < succeeded {
        forget = true
    }

    // 15、如果 job 的 status 有变化，将 job 的 status 更新到 apiserver
    if job.Status.Active != active || job.Status.Succeeded != succeeded || job.Status.Failed != failed || len(job.Status.Conditions) != conditions {
        job.Status.Active = active
        job.Status.Succeeded = succeeded
        job.Status.Failed = failed

        if err := jm.updateHandler(&job); err != nil {
            return forget, err
        }

        if jobHaveNewFailure && !IsJobFinished(&job) {
            return forget, fmt.Errorf("failed pod(s) detected for job key %q", key)
        }

        forget = true
    }

    return forget, manageJobErr
}
```



##### jm.manageJob

`jm.manageJob`它主要做的事情就是根据 job 配置的并发数来确认当前处于 active 的 pods 数量是否合理，如果不合理的话则进行调整，其主要逻辑为：

- 1、首先获取 job 的 active pods 数与可运行的 pod 数即 `job.Spec.Parallelism`；
- 2、判断如果处于 active 状态的 pods 数大于 job 设置的并发数 `job.Spec.Parallelism`，则并发删除多余的 active pods，需要删除的 active pods 是有一定的优先级的，删除的优先级为：
  - 1、判断是否绑定了 node：Unassigned < assigned；
  - 2、判断 pod phase：PodPending < PodUnknown < PodRunning；
  - 3、判断 pod 状态：Not ready < ready；
  - 4、若 pod 都为 ready，则按运行时间排序，运行时间最短会被删除：empty time < less time < more time；
  - 5、根据 pod 重启次数排序：higher restart counts < lower restart counts；
  - 6、按 pod 创建时间进行排序：Empty creation time pods < newer pods < older pods；

- 3、若处于 active 状态的 pods 数小于 job 设置的并发数，则需要根据 job 的配置计算 pod 的 diff 数并进行创建，计算方法与 `completions`、`parallelism` 以及 `succeeded` 的 pods 数有关，计算出 diff 数后会进行批量创建，创建的 pod 数依次为 1、2、4、8......，呈指数级增长，job 创建 pod 的方式与 rs 创建 pod 是类似的，但是此处并没有限制在一个 syncLoop 中创建 pod 的上限值，创建完 pod 后会将结果记录在 job 的 `expectations` 中，此处并非所有的 pod 都能创建成功，若超时错误会直接忽略，因其他错误创建失败的 pod 会记录在 `expectations` 中，`expectations` 机制的主要目的是减少不必要的 sync 操作，至于其详细的说明可以参考之前写的 ” ReplicaSetController 源码分析“ 一文；



`k8s.io/kubernetes/pkg/controller/job/job_controller.go:684`

```
func (jm *JobController) manageJob(activePods []*v1.Pod, succeeded int32, job *batch.Job) (int32, error) {
    // 1、获取 job 的 active pods 数与可运行的 pod 数
    var activeLock sync.Mutex
    active := int32(len(activePods))
    parallelism := *job.Spec.Parallelism
    jobKey, err := controller.KeyFunc(job)
    if err != nil {
        utilruntime.HandleError(fmt.Errorf("Couldn't get key for job %#v: %v", job, err))
        return 0, nil
    }

    var errCh chan error
    // 2、如果处于 active 状态的 pods 数大于 job 设置的并发数
    if active > parallelism {
        diff := active - parallelism
        errCh = make(chan error, diff)
        jm.expectations.ExpectDeletions(jobKey, int(diff))
        klog.V(4).Infof("Too many pods running job %q, need %d, deleting %d", jobKey, parallelism, diff)

        // 3、对 activePods 按以上 6 种策略进行排序
        sort.Sort(controller.ActivePods(activePods))

        // 4、并发删除多余的 active pods
        active -= diff
        wait := sync.WaitGroup{}
        wait.Add(int(diff))
        for i := int32(0); i < diff; i++ {
            go func(ix int32) {
                defer wait.Done()
                if err := jm.podControl.DeletePod(job.Namespace, activePods[ix].Name, job); err != nil {
                    defer utilruntime.HandleError(err)

                    klog.V(2).Infof("Failed to delete %v, decrementing expectations for job %q/%q", activePods[ix].Name, job.Namespace, job.Name)
                    jm.expectations.DeletionObserved(jobKey)
                    activeLock.Lock()
                    active++
                    activeLock.Unlock()
                    errCh <- err
                }
            }(i)
        }
        wait.Wait()

    // 5、若处于 active 状态的 pods 数小于 job 设置的并发数，则需要创建出新的 pod
    } else if active < parallelism {
    		// 6、首先计算出 diff 数
    		// 若 job.Spec.Completions == nil && succeeded pods > 0, 则diff = 0;
    		// 若 job.Spec.Completions == nil && succeeded pods = 0，则diff = Parallelism;
    		// 若 job.Spec.Completions != nil 则diff等于(job.Spec.Completions - succeeded - active)和 parallelism 中的最小值(非负值)；
        wantActive := int32(0)
        if job.Spec.Completions == nil {
            if succeeded > 0 {
                wantActive = active
            } else {
                wantActive = parallelism
            }
        } else {
            wantActive = *job.Spec.Completions - succeeded
            if wantActive > parallelism {
                wantActive = parallelism
            }
        }
        diff := wantActive - active
        if diff < 0 {
            utilruntime.HandleError(fmt.Errorf("More active than wanted: job %q, want %d, have %d", jobKey, wantActive, active))
            diff = 0
        }
        if diff == 0 {
            return active, nil
        }
        jm.expectations.ExpectCreations(jobKey, int(diff))
        errCh = make(chan error, diff)
        klog.V(4).Infof("Too few pods running job %q, need %d, creating %d", jobKey, wantActive, diff)
        active += diff
        wait := sync.WaitGroup{}

        // 7、批量创建 pod，呈指数级增长
        for batchSize := int32(integer.IntMin(int(diff), controller.SlowStartInitialBatchSize)); diff > 0; batchSize = integer.Int32Min(2*batchSize,     diff) {
            errorCount := len(errCh)
            wait.Add(int(batchSize))
            for i := int32(0); i < batchSize; i++ {
                go func() {
                    defer wait.Done()
                    err := jm.podControl.CreatePodsWithControllerRef(job.Namespace, &job.Spec.Template, job, metav1.NewControllerRef(job,                controllerKind))
                    // 8、调用 apiserver 创建时忽略 Timeout 错误
                    if err != nil && errors.IsTimeout(err) {
                        return
                    }
                    if err != nil {
                        defer utilruntime.HandleError(err)
                        klog.V(2).Infof("Failed creation, decrementing expectations for job %q/%q", job.Namespace, job.Name)
                        jm.expectations.CreationObserved(jobKey)
                        activeLock.Lock()
                        active--
                        activeLock.Unlock()
                        errCh <- err
                    }
                }()
            }
            wait.Wait()

            // 9、若有创建失败的操作记录在 expectations 中
            skippedPods := diff - batchSize
            if errorCount < len(errCh) && skippedPods > 0 {
                klog.V(2).Infof("Slow-start failure. Skipping creation of %d pods, decrementing expectations for job %q/%q", skippedPods, job.Namespace, job.Name)
                active -= skippedPods
                for i := int32(0); i < skippedPods; i++ {
                    jm.expectations.CreationObserved(jobKey)
                }
                break
            }
            diff -= batchSize
        }
    }
    select {
    case err := <-errCh:
        if err != nil {
            return active, err
        }
    default:
    }

    return active, nil
}
```



### 总结

以上就是 jobController 源码中主要的逻辑，从上文分析可以看到 jobController 的代码比较清晰，若看过前面写的几个 controller 分析会发现每个 controller 在功能实现上有很多类似的地方。
