package com.autumnharvestc.server.execution.agent;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.JdbcTemplate;
import com.autumnharvestc.server.auth.TokenService;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;

@Component
@Order(10)
public class AgentAuthFilter extends OncePerRequestFilter {
    private final JdbcTemplate jdbc;
    private final TokenService tokens;
    private final ObjectMapper json;
    public AgentAuthFilter(JdbcTemplate jdbc,TokenService tokens,ObjectMapper json){this.jdbc=jdbc;this.tokens=tokens;this.json=json;}
    @Override protected boolean shouldNotFilter(HttpServletRequest request){String path=request.getRequestURI();return !path.equals("/api/v1/runner")&&!path.startsWith("/api/v1/runner/");}
    @Override protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain) throws ServletException,IOException {
        String path=request.getRequestURI(),method=request.getMethod();
        if(path.equals("/api/v1/runner/enroll")&&method.equals("POST")){chain.doFilter(request,response);return;}
        boolean control=method.equals("POST")&&java.util.Set.of("/api/v1/runner/poll","/api/v1/runner/heartbeat","/api/v1/runner/messages","/api/v1/runner/runtime").contains(path);
        boolean data=(method.equals("GET")&&path.matches("/api/v1/runner/jobs/[1-9][0-9]*/inputs"))
            ||(method.equals("POST")&&path.matches("/api/v1/runner/jobs/[1-9][0-9]*/materials"))
            ||(method.equals("PUT")&&path.matches("/api/v1/runner/jobs/[1-9][0-9]*/report"));
        if(!control&&!data){reject(response,401,"unauthorized","未知代理入口或方法");return;}
        String header=request.getHeader("Authorization");
        if(header==null||!header.regionMatches(true,0,"Bearer ",0,7)||header.substring(7).trim().isEmpty()){reject(response,401,"unauthorized","需要有效代理身份");return;}
        AgentPrincipal principal;
        try { principal=jdbc.query("SELECT id FROM execution_agents WHERE identity_hash=? AND revoked=FALSE",(r,n)->new AgentPrincipal(r.getLong(1)),tokens.sha256Hex(header.substring(7).trim())).stream().findFirst().orElse(null); }
        catch(RuntimeException ex){reject(response,500,"internal_error","服务端内部错误");return;}
        if(principal==null){reject(response,401,"unauthorized","代理身份无效或已撤销");return;}
        request.setAttribute(AgentPrincipal.ATTRIBUTE,principal);chain.doFilter(request,response);
    }
    private void reject(HttpServletResponse response,int status,String code,String message)throws IOException{response.setStatus(status);response.setContentType("application/json");response.setCharacterEncoding(StandardCharsets.UTF_8.name());response.getWriter().write(json.writeValueAsString(Map.of("code",code,"message",message)));}
}
