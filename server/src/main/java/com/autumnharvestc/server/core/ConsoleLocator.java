package com.autumnharvestc.server.core;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * 管理后台静态产物定位（规格 m4 §2 D2）：配置键 apicc.server.console-dir（裁定①，默认 ./console，与 server-data 同级）。
 * 可用性 = 目录下存在 index.html；启动期不做任何扫描（产物可在运行中构建后放置，无需重启即可生效）。
 * 被 GlobalExceptionHandler（console 缺失时的 404 语义）与 console 包（静态托管）共用。
 */
@Component
public class ConsoleLocator {

    /** 404 引导文案主体（裁定③：指引构建 admin-web 并将 dist 放入 console-dir）。 */
    static final String GUIDANCE =
            "管理后台未部署：请执行 pnpm -C apps/admin-web build 构建控制台，并将 dist 目录内容放入 console 目录（apicc.server.console-dir）";

    private final Path root;

    public ConsoleLocator(@Value("${apicc.server.console-dir:./console}") String consoleDir) {
        this.root = Paths.get(consoleDir).normalize();
    }

    /** console 产物根目录（可能不存在，调用方按缺失处理）。 */
    public Path root() {
        return root;
    }

    /** 控制台入口文件路径（console-dir/index.html）。 */
    public Path indexHtml() {
        return root.resolve("index.html");
    }

    /** 控制台是否可服务：index.html 存在即可（目录不存在或为空 → false，对应裁定③）。 */
    public boolean isAvailable() {
        return Files.isRegularFile(indexHtml());
    }

    /** 404 console_not_found 的引导文案（附带当前生效目录，便于自托管者核对放置位置）。 */
    public String notFoundMessage() {
        return GUIDANCE + "，当前配置为 " + root;
    }
}
