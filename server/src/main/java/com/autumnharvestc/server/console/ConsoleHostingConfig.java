package com.autumnharvestc.server.console;

import com.autumnharvestc.server.core.ConsoleLocator;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.web.servlet.resource.HttpResource;
import org.springframework.web.servlet.resource.PathResourceResolver;
import org.springframework.web.servlet.resource.ResourceResolverChain;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URL;
import java.nio.channels.ReadableByteChannel;
import java.util.List;
import java.util.Locale;

/**
 * 管理后台静态托管（规格 m4 §2 D2/D3，裁定②④）：
 * <ul>
 *   <li>资源映射 /** → file:{console-dir}/；PathResourceResolver 自带 isResourceUnderLocation 防穿越
 *      （resolve 后必须仍在 console-dir 内，否则不返回资源）——裁定②；</li>
 *   <li>SPA 回退：非 /api/**、无扩展名、未命中的 GET → 以 console-dir/index.html 应答（存在时）——裁定②；
 *       /api 面与带扩展名路径不回退（未命中原样 404，语义交 GlobalExceptionHandler）；</li>
 *   <li>响应头：html 一律不缓存（no-cache），assets 类保持 Spring 默认（Last-Modified 协商）——
 *       开发友好优先（裁定④，产物更新即时可见；缓存/压缩调优已在计划中明确推迟）；</li>
 *   <li>不启用资源链缓存：回退命中无上限增长（任意深链都缓存 index.html）且开发期产物可即时替换。</li>
 * </ul>
 * 根路径 GET / 由 {@link ConsoleWelcomeController} 承接：框架对空路径不进入解析器（shouldIgnoreInputPath）。
 */
@Configuration
public class ConsoleHostingConfig implements WebMvcConfigurer {

    private final ConsoleLocator console;

    public ConsoleHostingConfig(ConsoleLocator console) {
        this.console = console;
    }

    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        // Path.toUri() 以运行目录解析相对路径并转义特殊字符，必须保证结尾斜杠否则 createRelative 丢末段
        String location = console.root().toUri().toString();
        if (!location.endsWith("/")) {
            location += "/";
        }
        registry.addResourceHandler("/**")
                .addResourceLocations(location)
                .resourceChain(false)
                .addResolver(new SpaFallbackResolver());
    }

    /**
     * 未命中回退：先按默认链解析（含防穿越校验），再按裁定②条件回退 index.html。
     * resourcePath 为框架归一后的相对路径（无前导斜杠、反斜杠已转正斜杠）。
     */
    static final class SpaFallbackResolver extends PathResourceResolver {

        @Override
        protected Resource resolveResourceInternal(HttpServletRequest request, String requestPath,
                                                   List<? extends Resource> locations,
                                                   ResourceResolverChain chain) {
            Resource resolved = super.resolveResourceInternal(request, requestPath, locations, chain);
            if (resolved != null) {
                return noCacheIfHtml(resolved);
            }
            if (isApiPath(requestPath) || hasFileExtension(requestPath)) {
                return null;
            }
            Resource index = super.resolveResourceInternal(request, "index.html", locations, chain);
            return index != null ? noCacheIfHtml(index) : null;
        }

        /** /api 面严禁回退（/api 未命中必须保持 JSON 404 语义——裁定②③）。 */
        private static boolean isApiPath(String requestPath) {
            return requestPath.equals("api") || requestPath.startsWith("api/");
        }

        /** 末段含「.」视为静态资源请求（如 missing.js）→ 不回退，保持 404。 */
        private static boolean hasFileExtension(String requestPath) {
            int lastSegmentStart = requestPath.lastIndexOf('/') + 1;
            return requestPath.indexOf('.', lastSegmentStart) >= 0;
        }

        /** html 响应不缓存（裁定④）；其余资源原样返回、走 Spring 默认头。 */
        private static Resource noCacheIfHtml(Resource resource) {
            String filename = resource.getFilename();
            if (filename == null || !filename.toLowerCase(Locale.ROOT).endsWith(".html")) {
                return resource;
            }
            return new NoCacheHtmlResource(resource);
        }
    }

    /**
     * 为 html 资源追加 Cache-Control: no-cache 的 HttpResource 委托包装；
     * 其余行为（流/长度/协商头）全部透传给被包装资源。
     */
    private static final class NoCacheHtmlResource implements HttpResource {

        private final Resource delegate;

        private NoCacheHtmlResource(Resource delegate) {
            this.delegate = delegate;
        }

        @Override
        public HttpHeaders getResponseHeaders() {
            HttpHeaders headers = new HttpHeaders();
            headers.setCacheControl(CacheControl.noCache().getHeaderValue());
            return headers;
        }

        @Override
        public InputStream getInputStream() throws IOException {
            return delegate.getInputStream();
        }

        @Override
        public long contentLength() throws IOException {
            return delegate.contentLength();
        }

        @Override
        public long lastModified() throws IOException {
            return delegate.lastModified();
        }

        @Override
        public boolean exists() {
            return delegate.exists();
        }

        @Override
        public boolean isReadable() {
            return delegate.isReadable();
        }

        @Override
        public boolean isOpen() {
            return delegate.isOpen();
        }

        @Override
        public boolean isFile() {
            return delegate.isFile();
        }

        @Override
        public URL getURL() throws IOException {
            return delegate.getURL();
        }

        @Override
        public URI getURI() throws IOException {
            return delegate.getURI();
        }

        @Override
        public File getFile() throws IOException {
            return delegate.getFile();
        }

        @Override
        public ReadableByteChannel readableChannel() throws IOException {
            return delegate.readableChannel();
        }

        @Override
        public Resource createRelative(String relativePath) throws IOException {
            return delegate.createRelative(relativePath);
        }

        @Override
        public String getFilename() {
            return delegate.getFilename();
        }

        @Override
        public String getDescription() {
            return delegate.getDescription();
        }
    }
}
