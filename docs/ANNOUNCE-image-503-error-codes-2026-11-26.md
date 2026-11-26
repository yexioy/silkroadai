# 【变更通知稿】图片 API 5xx 报错细分(503 overloaded 拆分)— 待 operator 发送

> 发送对象:gpt-image 全系(gpt-image-2 / 2.5 / 2.6)大客户,尤其是自己也跑 new-api 的中转型客户(他们日志里看到的就是 `status_code=503, The engine is currently overloaded`);渠道:微信/邮件。以下为可直接粘贴的正文。**部署完成后再发**,生效日期按实际部署日填。

---

尊敬的客户:

此前图片接口(`/v1/images/generations` 与 `/v1/images/edits`)在请求最终失败时,多数情况统一返回:

```
503 The engine is currently overloaded, please try again later.
```

这句话把几种完全不同的原因合并在了一起,容易被理解成"平台资源饱和",也看不出该不该重试、该改什么。自 2026-11-XX 起,这类报错按真实原因拆分。错误体仍是 OpenAI 官方四字段形,**新增的信息都在 `error.code` 里**:

| HTTP | error.code                          | 含义                                                                 | 建议处理                                        |
| ---- | ----------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| 503  | `engine_overloaded`                 | 线路过载 / 上游限流(只有这一种才是"overloaded")                      | 按响应头 `Retry-After` 秒数退避后重试           |
| 503  | `upstream_unavailable`              | 该模型的线路暂时不可用(供给侧故障,不是资源饱和,也不是你的请求有问题) | 稍后重试;持续出现请联系我们,无需调并发或参数    |
| 503  | `parameter_combination_unavailable` | 当前没有线路承接这组参数(尺寸 / 档位 / 透明背景 / 蒙版的组合)        | 换一组参数,或稍后重试                           |
| 500  | `upstream_error`                    | 平台或上游临时错误(网络抖动、空返回、上游内部故障)                   | 直接重试                                        |
| 500  | `upstream_timeout`                  | 出图超时                                                             | 直接重试                                        |
| 400  | `no_image_generated`                | 模型没有出图:提示词被理解成文字类请求,或提到了参考图但请求里没带     | **原样重发无效**,请改写提示词 / 附上参考图      |
| 400  | `invalid_image`                     | 输入图或蒙版损坏、格式不支持(如 avif)                                | **原样重发无效**,message 会写明第几张、什么问题 |

**与旧行为的差异(如你的代码按旧值分支,请对照迁移)**

- 原来 `503 overloaded` 的 `error.code` 为 `null`,现在 5xx 都带 `code`;
- 上游临时错误 / 超时:HTTP 状态由 **503 → 500**(`upstream_error` / `upstream_timeout`);
- 模型没出图:由 **503 → 400 `no_image_generated`**;
- 输入图损坏 / 格式不支持:由 **503 → 400 `invalid_image`**,并带具体原因;
- `503 engine_overloaded` 新增 `Retry-After` 响应头。

**不变的部分**

- 500 / 503 依然都可以直接重试,官方 openai SDK 的自动重试行为不受影响;
- 所有报错请求**一律不计费**;
- 成功响应的格式、计费、模型行为均无任何变化;
- 审核拒绝(400 `moderation_blocked`)、限流(429 `rate_limit_exceeded`)、余额不足(429 `insufficient_quota`)等其它报错不变;
- 完整对照表已更新至 https://silkroadai.io/docs#errors 。

如接入中有任何疑问,随时联系我们。

Silk Road AI
