package com.autumnharvestc.server.console;

import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.core.ConsoleLocator;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 管理后台入口页（规格 m4 §2 D2/D3）：GET / → console-dir/index.html。
 * 资源处理器对空路径不进入解析器（框架忽略），根路径须显式承接（计划：「/ 直接映射 index.html」）。
 * console 缺失（目录不存在或无 index.html）→ 404 console_not_found + 引导文案（裁定③）；
 * 静态面不要求认证（裁定⑤：AuthFilter shouldNotFilter 本就只拦 /api/v1/**，未改动）。
 */
@RestController
public class ConsoleWelcomeController {

    private final ConsoleLocator console;

    public ConsoleWelcomeController(ConsoleLocator console) {
        this.console = console;
    }

    @GetMapping("/")
    public ResponseEntity<Resource> index() {
        if (!console.isAvailable()) {
            throw new ApiException(HttpStatus.NOT_FOUND, "console_not_found", console.notFoundMessage());
        }
        return ResponseEntity.ok()
                .contentType(MediaType.TEXT_HTML)
                .cacheControl(CacheControl.noCache())
                .body(new FileSystemResource(console.indexHtml()));
    }
}
