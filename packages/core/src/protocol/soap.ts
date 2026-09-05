import { httpClient } from "../http/client.js";
import type { ExecutableRequest, ExecutionResponse, HttpExecuteOptions, ProtocolClient } from "../plugin/types.js";
import { canHandleProtocol } from "./index.js";

/**
 * SOAP 协议客户端（M5 D4，裁定 A）：构造 BodyContent（变量解析后的 envelope 原文）后
 * 委托既有 httpClient.execute——连接/总超时与网络错误分类（HttpExecutionError）全部
 * 透传复用，本客户端不做二次分类。
 *
 * 头部口径（SOAP 1.1，规格注明 1.2 Content-Type 细分推迟）：
 * - Content-Type 缺省补 `text/xml; charset=utf-8`；用户已显式声明时不覆盖（SOAP 1.2 等场景的显式出口）。
 * - soapAction 存在 → `SOAPAction` 头；缺省不带该头。
 *
 * 响应映射：status/headers/bodyText/timeMs 即 HTTP 语义透传——SOAP fault（非 2xx）是
 * 合法响应而非执行错误，由断言层处理。
 */
export const soapClient: ProtocolClient = {
  name: "soap",
  canHandle: (req) => canHandleProtocol(req, "soap"),
  async execute(req: ExecutableRequest, opts: HttpExecuteOptions): Promise<ExecutionResponse> {
    if (req.envelope === undefined) {
      throw new Error("soap 请求必须提供 envelope（XML 信封模板）");
    }
    const headers = { ...req.headers };
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
      headers["content-type"] = "text/xml; charset=utf-8";
    }
    if (req.soapAction !== undefined) {
      headers["SOAPAction"] = req.soapAction;
    }
    return await httpClient.execute(
      { ...req, method: "POST", headers, body: { kind: "xml", content: req.envelope } },
      opts,
    );
  },
};
