---
author: Alexey Ermolaev
pubDatetime: 2025-06-15T16:01:00Z
modDatetime: 2025-06-15T16:01:00Z
title: Data capture for ML endpoints
slug: data-capture-ml-endpoints
featured: true
draft: false
tags:
  - data capture
description: One of the approaches of how how you can add data capture to your ML endpoints
---

Imagine, you have some endpoint running somewhere. What you need is to capture your requests and responses. Maybe you will need to for debugging, training some ML models based on this data or something else.

Sure, you can use `Kibana` or other logging solutions your company is using but it will most probably contain some additional data you don't need. It will fill your storage quite quick. As well, you don't have control over the data if:

- You need some specific format (unless, you do it on the backend side but it brings additional complexity)
- You need only sample of data

There is an open-source tool for these purposes called [goreplay](https://github.com/buger/goreplay). It's an amazing tool which allow you to setup data capture out of the box in a matter of a few commands.

For example, if your endpoint is called `/predict` and is running on port `5000` you can easily put something like

```bash
gor --input-raw :5000 --input-raw-track-response --http-allow-url /predict --output-file log.txt
```

There are more options available which control how and where do you put the data, how do you control the size of it. You can check it out in the official documentation. Btw, you can use goreplay as a standalone binary `gor` and download it from it's repo or use Docker image provided.

Ok, all good, it's capturing the data, storing it in some file somewhere on a shared volume or anywhere you decied to put it. Now, you want to upload it to aws s3 because it's more resilient and maybe easier for a later analysis.

Goreplay has it's capability but as a premium feature. If you don't have budget for this, how can you solve this issue?

For this, there is a [fluent-bit](https://github.com/fluent/fluent-bit) open-source tool.

You can set it up to listen for the updates of the log file you created with goreplay and the upload chunks of the data periodically to s3. It's all specified in the fluentbit [config](https://docs.fluentbit.io/manual/administration/configuring-fluent-bit/classic-mode/configuration-file). It's pretty easy so just take a look, it also let you control how much of the data in the chunk you want to upload to s3 or how frequently. Additionally, if you need output data in the specific format, `fluent-bit` support lua [scripting](https://docs.fluentbit.io/manual/pipeline/filters/lua) where you can manipulate data from the log and make it the same format as you need.

To run fluent-bit, just use `fluent-but -c fluent-bit.conf` with the config you created. 

Example of the config:

```
[INPUT]
    Name tail
    Path /path/to/your/goreplay/log
    Tag goreplay
[FILTER] <----- THIS IS OPTIONAL IF YOU NEED FILTERING
    Name lua
    Match goreplay
    Script /your/lua/script/if/any
[OUTPUT]
    Name s3
    Match *
    bucket name_of_s3_bucket
    region your-region
    store_dir /fluent-bit/s3 <--- change to your path
    s3_key_format /data/%Y/%m/%d/%H/$UUID.json
    use_put_object On
```

This is just example config, please check out docs for additional options suitable for your needs.

That's it! At the end you will have a proper data capture setup which you can use and scale if needed.