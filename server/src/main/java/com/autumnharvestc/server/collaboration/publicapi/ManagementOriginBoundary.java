package com.autumnharvestc.server.collaboration.publicapi;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.IOException;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/** Public URLs have their own real listener, so management never routes them into SPA/static fallback. */
@Component
@Order(0)
public class ManagementOriginBoundary extends OncePerRequestFilter {
    public static boolean publicPath(String path){return path.equals("/s")||path.startsWith("/s/")||path.equals("/share-api")||path.startsWith("/share-api/")||path.equals("/mock")||path.startsWith("/mock/")||path.equals("/share-viewer")||path.startsWith("/share-viewer/");}
    @Override protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain)throws IOException,ServletException {
        if(publicPath(request.getRequestURI())){
            response.setStatus(404);response.setContentType("application/json");response.setHeader("Cache-Control","no-store");
            response.getWriter().write("{\"code\":\"share_unavailable\",\"message\":\"共享入口不可用\"}");return;
        }
        chain.doFilter(request,response);
    }
}
