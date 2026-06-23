---
author: Alexey Ermolaev
pubDatetime: 2025-10-05T12:11:00Z
modDatetime: 2025-06-05T12:11:00Z
title: Python asyncio internals
slug: python-asyncio-internals
featured: true
draft: false
tags:
  - python
  - asyncio
  - event loop
  - asynchronous
description: A brief intro into asyncio internals in Python
headerArt: /art/asyncio.svg
---

Nowadays, I am working mostly with Python, Golang, Rust and TypeScript (with NodeJS). I was thinking that it would be good to have a summary of how async runtimes work in that languages. Primarly, when you switch between it often, not to forget nuances.

This is the first part of the series where I will cover `asyncio`.

It won't be a very detailed guide, but more like a cheatsheet which can be used by anyone interested (and for myself, of course). I will also provide minimal code snippets.

## Asyncio

I will focus in `asyncio` and it's event loop. It's a built-in library for writing concurrent code. `asyncio` operates with coroutines which, in turn, use cooperative scheduling to be running in an effective manner. It means that tasks volunterily give up control (the event loop forcibly interrupts a running coroutine).

The system diagram can be summarized like this:

```
┌────────────────────────────────────────────────────────────────────────┐
│                          asyncio Event Loop                             │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │                    Core Scheduling Components                     │ │
│  │                                                                    │ │
│  │  ┌─────────────────────┐      ┌──────────────────────────────┐  │ │
│  │  │  Ready Callbacks/   │      │   Timer Heap (Scheduled)     │  │ │
│  │  │      Tasks          │      │   - call_later/call_at       │  │ │
│  │  │  (deque - FIFO)     │      │   - asyncio.sleep            │  │ │
│  │  │                     │      │   (min-heap by deadline)     │  │ │
│  │  └─────────────────────┘      └──────────────────────────────┘  │ │
│  │                                                                    │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │                 I/O Backend (Platform-specific)                   │ │
│  │                                                                    │ │
│  │  Unix/Linux: epoll, kqueue, devpoll, select (via selectors)     │ │
│  │  Windows: IOCP (Proactor) or Windows Selector                    │ │
│  │                                                                    │ │
│  │  - Monitors file descriptors / handles                           │ │
│  │  - Returns ready I/O events                                       │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │                    Task & Future System                           │ │
│  │                                                                    │ │
│  │  Future: Low-level awaitable with result/exception              │ │
│  │  Task: Wraps coroutine, drives execution via _step()            │ │
│  │  TaskGroup (3.11+): Structured concurrency, error propagation   │ │
│  │                                                                    │ │
│  │  Cancellation: Sets flag → injects CancelledError on resume     │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │                      I/O Abstractions                             │ │
│  │                                                                    │ │
│  │  Streams: High-level async I/O (StreamReader/StreamWriter)      │ │
│  │  Transports: Byte-level I/O abstraction                         │ │
│  │  Protocols: Callback-based interface (legacy)                   │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │                    Extension Systems                              │ │
│  │                                                                    │ │
│  │  Executors: Thread/Process pools for blocking work              │ │
│  │  Signal Handlers: Unix signal integration                        │ │
│  │  Subprocess: Async process management                            │ │
│  │  Context Variables: Per-task context propagation                │ │
│  │  Async Generators: Finalization & cleanup                        │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │              Exception & Debug Infrastructure                     │ │
│  │                                                                    │ │
│  │  Exception Handler: Logs unhandled task exceptions              │ │
│  │  Debug Mode: Tracks slow callbacks, unawaited coroutines        │ │
│  └──────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```
The event loop workflow is rather simple. I will simplify it and will ignore some details but overall the flow is:

1. Move due scheduled callbacks (timers) to the ready queue

The event loop keeps a min-heap of scheduled handles (timers).
Each has a _when timestamp.
Loop peeks at the soonest one:

If *when <= now, it pops it and appends to *ready.
If not yet due, it stops checking (heap is sorted).

**This moves callbacks from the Timer Heap → Ready Queue when they’re due.**

2. Compute how long to wait (poll timeout)

If _ready is not empty, timeout = 0 → don’t block; just run ready callbacks.
Else if _scheduled not empty:

Timeout = scheduled[0].when - now (until next timer is due).
Else:

Timeout = None (block indefinitely — no tasks waiting).
**This determines how long to wait for I/O events.**

3. Poll I/O backend (selectors / IOCP)

The event loop calls `self._selector.select(timeout)`.
The selector blocks for at most that timeout.

On Unix: epoll, kqueue, or select via selectors module.
On Windows: IOCP (Proactor), or a SelectSelector if manually chosen.
**It returns a list of file objects that are ready for I/O (read/write).**

4. Move ready I/O callbacks to the ready queue

For each ready file descriptor:

Retrieve the registered read/write callbacks.
If still valid and not cancelled, append to _ready.
**Now the ready queue contains both due timers and ready I/O callbacks.**

5. Drain the ready queue

The loop drains *ready by calling each handle’s *run() method.
Each handle may:

Resume a coroutine (via its Task’s _step()).
Schedule new timers or tasks.
Add more callbacks to _ready.
**This is where actual coroutine code runs — everything else above is just bookkeeping.**

6. Handle exceptions (optional step)

If a callback raises and doesn’t handle it:

The loop passes it to call_exception_handler().
Usually logs it unless a custom handler is set.

## Notes

You may be wondering what's the difference between `coroutine` and `task`. When you await coroutine, you're executing it inside the current task. The current task suspends until `do_calculation()` completes.

Example:
```python
async def main():
    result = await do_calculation() # main() is awaiting coroutine
```
When you wrap coroutine in a separate task, you schedule to run it concurrently.

Example:

```python
async def main():
    task = asyncio.create_task(do_calculation()) # creates a new task, main() continues immediately
    result = await task
```


Some fast code snippets as a reference

```python
## Coroutine

import asyncio


async def greet(name):
    print(f"Hello {name}!")
    await asyncio.sleep(1)
    print(f"Goodbye {name}!")


async def main_coroutine():
    # Awaiting coroutine runs it *in this task* (sequentially)
    await greet("Alice")
    await greet("Bob")


asyncio.run(main_coroutine())


## Tasks with concurrency


async def do_work(name, delay):
    print(f"{name} started")
    await asyncio.sleep(delay)
    print(f"{name} done")
    return f"result-{name}"


async def main_tasks():
    # Create concurrent tasks
    t1 = asyncio.create_task(do_work("A", 2))
    t2 = asyncio.create_task(do_work("B", 1))

    print("Both started!")
    # Wait for both
    results = await asyncio.gather(t1, t2)
    print("Results:", results)


asyncio.run(main_tasks())

## Queue (producer-consumer)


async def producer(queue):
    for i in range(5):
        print(f"Producing {i}")
        await queue.put(i)
        await asyncio.sleep(0.5)
    await queue.put(None)  # Sentinel for termination


async def consumer(queue):
    while True:
        item = await queue.get()
        if item is None:
            break
        print(f"Consuming {item}")
        await asyncio.sleep(1)


async def main_queue():
    q = asyncio.Queue()
    await asyncio.gather(producer(q), consumer(q))


asyncio.run(main_queue())


## Tasks cancellation


async def long_job():
    try:
        print("Task started")
        await asyncio.sleep(10)
        print("Task finished")
    except asyncio.CancelledError:
        print("Task was cancelled!")


async def main_tasks_cancel():
    t = asyncio.create_task(long_job())
    await asyncio.sleep(2)
    t.cancel()
    await t  # must await to handle cancellation cleanly


asyncio.run(main_tasks_cancel())


## Timeout


async def slow():
    await asyncio.sleep(5)
    return "done"


async def main_timeout():
    try:
        await asyncio.wait_for(slow(), timeout=2)
    except asyncio.TimeoutError:
        print("Timed out!")


asyncio.run(main_timeout())

## TaskGroups (all tasks inside the group complete or cancel together) Python 3.11+


async def worker(n):
    await asyncio.sleep(n)
    print(f"Worker {n} done")


async def main_task_group():
    async with asyncio.TaskGroup() as tg:
        tg.create_task(worker(1))
        tg.create_task(worker(2))
        tg.create_task(worker(3))
    print("All workers done")


asyncio.run(main_task_group())


## Executors for Blocking Code (To run blocking functions (e.g., file I/O, heavy CPU code))
import time


def blocking_task():
    time.sleep(2)
    return "finished blocking task"


async def main_blocking():
    loop = asyncio.get_running_loop()
    # run_in_executor() (or asyncio.to_thread) runs blocking code in a thread or process pool
    # so it doesnâ€™t block the loop.
    result = await loop.run_in_executor(None, blocking_task)
    print(result)


asyncio.run(main_blocking())


## Synchronization Primitives

lock = asyncio.Lock()


async def worker_sync(name):
    async with lock:
        print(f"{name} has lock")
        await asyncio.sleep(1)
    print(f"{name} released lock")


async def main_sync():
    # Only one coroutine at a time can hold the lock.
    await asyncio.gather(worker_sync("A"), worker_sync("B"), worker_sync("C"))


asyncio.run(main_sync())

## gathering waiting

# wait() gives you more granular control (timeouts, partial completions).
# gather() waits for all tasks or fails if any do.


async def job_gather(i):
    await asyncio.sleep(i)
    return i


async def main_gathering():
    tasks = [asyncio.create_task(job_gather(i)) for i in range(3)]
    done, pending = await asyncio.wait(tasks, timeout=1.5)
    print("Done:", [t.result() for t in done])
    print("Pending:", [t._coro.__name__ for t in pending])


asyncio.run(main_gathering())
```
