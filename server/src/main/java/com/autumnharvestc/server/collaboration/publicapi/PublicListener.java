package com.autumnharvestc.server.collaboration.publicapi;

import com.autumnharvestc.server.collaboration.grants.GrantService;
import com.autumnharvestc.server.collaboration.grants.ShareInactive;
import com.autumnharvestc.server.core.ApiException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;
import jakarta.annotation.PreDestroy;

/** Separate public listener: it never enters the management servlet, static chain or cookie handling. */
@Component
@org.springframework.core.annotation.Order(1)
public class PublicListener implements ApplicationRunner {
    private final PublicAccessProperties properties;
    private final GrantService grants;
    private final com.autumnharvestc.server.collaboration.audit.AccessObservations observations;
    private org.apache.hc.core5.http.impl.bootstrap.HttpAsyncServer server;
    private InetSocketAddress address;
    private final java.util.Set<PublicExchange> active=java.util.concurrent.ConcurrentHashMap.newKeySet();
    private record RequestTransport(boolean absolute,String sessionId){}
    private final java.util.Map<org.apache.hc.core5.http.HttpRequest,RequestTransport> requestTransports=java.util.Collections.synchronizedMap(new java.util.WeakHashMap<>());
    private final java.util.Map<String,org.apache.hc.core5.reactor.IOSession> sessions=new java.util.concurrent.ConcurrentHashMap<>();
    private final com.fasterxml.jackson.databind.ObjectMapper json;
    private final PublicAdmissionState admissionState;
    private final com.autumnharvestc.server.collaboration.mock.SharedMockGateway mockGateway;
    private final com.autumnharvestc.server.collaboration.mock.MockLimiter mockLimits;
    private final com.autumnharvestc.server.collaboration.policy.CollaborationPolicyService policies;
    private final PublicViewerResources viewer;
    private final java.util.concurrent.ExecutorService executor=java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor();
    public PublicListener(PublicAccessProperties properties,GrantService grants,com.fasterxml.jackson.databind.ObjectMapper json,PublicAdmissionState admissionState,com.autumnharvestc.server.collaboration.mock.SharedMockGateway mockGateway,com.autumnharvestc.server.collaboration.mock.MockLimiter mockLimits,com.autumnharvestc.server.collaboration.policy.CollaborationPolicyService policies,com.autumnharvestc.server.collaboration.audit.AccessObservations observations){this.observations=observations;this.properties=properties;this.grants=grants;this.json=json;this.admissionState=admissionState;this.mockGateway=mockGateway;this.mockLimits=mockLimits;this.policies=policies;this.viewer=new PublicViewerResources(properties);}
    @Override public void run(ApplicationArguments arguments)throws Exception {
        if(!properties.isEnabled()||!grants.publicOriginConfigured())return;
        server=org.apache.hc.core5.http.impl.bootstrap.AsyncServerBootstrap.bootstrap()
            .setIOReactorConfig(org.apache.hc.core5.reactor.IOReactorConfig.custom().setIoThreadCount(1).build())
            // HttpCore disconnects the original delegate, not the connected callback's decorator.
            .setIOSessionDecorator(session->{sessions.put(session.getId(),session);return new DisconnectSession(session);})
            .setIOSessionListener(new org.apache.hc.core5.reactor.IOSessionListener(){
                @Override public void connected(org.apache.hc.core5.reactor.IOSession session){}
                @Override public void disconnected(org.apache.hc.core5.reactor.IOSession session){sessions.remove(session.getId(),session);}
                @Override public void startTls(org.apache.hc.core5.reactor.IOSession session){}
                @Override public void inputReady(org.apache.hc.core5.reactor.IOSession session){}
                @Override public void outputReady(org.apache.hc.core5.reactor.IOSession session){}
                @Override public void timeout(org.apache.hc.core5.reactor.IOSession session){}
                @Override public void exception(org.apache.hc.core5.reactor.IOSession session,Exception error){}
            })
            .setStreamListener(new org.apache.hc.core5.http.impl.Http1StreamListener(){
                // Capture the parsed request-target form before HttpCore enriches scheme/Host.
                @Override public void onRequestHead(org.apache.hc.core5.http.HttpConnection connection,org.apache.hc.core5.http.HttpRequest request){requestTransports.put(request,new RequestTransport(request.getScheme()!=null,((org.apache.hc.core5.util.Identifiable)connection).getId()));}
                @Override public void onResponseHead(org.apache.hc.core5.http.HttpConnection connection,org.apache.hc.core5.http.HttpResponse response){}
                @Override public void onExchangeComplete(org.apache.hc.core5.http.HttpConnection connection,boolean keepAlive){}
            })
            .setRequestRouter((request,context)->()->{var transport=requestTransports.remove(request);var session=sessions.get(transport.sessionId());var owned=new PublicExchange(executor,exchange->{
            try{
                String path=exchange.getRequestURI().getPath();
                var headers=exchange.getResponseHeaders();headers.set("Cache-Control","no-store");headers.set("X-Content-Type-Options","nosniff");headers.set("Referrer-Policy","no-referrer");headers.set("Content-Security-Policy","default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox");
                if(!admissionState.ready()||!grants.publicOriginConfigured())throw new ApiException(org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE,"public_origin_unavailable","公共来源尚未完成策略对账");
                boolean shell=path.matches("/s/[A-Za-z0-9_-]{22}");
                boolean data=path.matches("/share-api/[A-Za-z0-9_-]{22}(/download)?");
                boolean mock=path.matches("/mock/[A-Za-z0-9_-]{22}(/.*)?");
                if(path.equals("/share-viewer/viewer.js")||path.equals("/share-viewer/viewer.css")){
                    if(!exchange.getRequestMethod().equals("GET"))throw new ApiException(org.springframework.http.HttpStatus.NOT_FOUND,"share_unavailable","共享入口不可用");
                    boolean script=path.endsWith(".js");byte[] resource=script?viewer.script():viewer.style();
                    headers.set("Content-Type",script?"text/javascript; charset=utf-8":"text/css; charset=utf-8");exchange.sendResponseHeaders(200,resource.length);exchange.getResponseBody().write(resource);return;
                }
                if(!shell&&!data&&!mock){byte[] body="{\"code\":\"share_unavailable\"}".getBytes(StandardCharsets.UTF_8);headers.set("Content-Type","application/json; charset=utf-8");exchange.sendResponseHeaders(404,body.length);exchange.getResponseBody().write(body);return;}
                if(mock&&exchange.getRequestMethod().equals("OPTIONS")&&exchange.getRequestHeaders().getFirst("Origin")!=null&&exchange.getRequestHeaders().getFirst("Access-Control-Request-Method")!=null){
                    preflight(exchange);return;
                }
                if((shell||data)&&!exchange.getRequestMethod().equals("GET"))throw new ApiException(org.springframework.http.HttpStatus.NOT_FOUND,"share_unavailable","共享入口不可用");
                byte[] body;
                if(data){
                    String id=path.substring("/share-api/".length()).split("/")[0];boolean download=path.endsWith("/download");
                    try(var admission=grants.admit(id,exchange.getRequestHeaders().getFirst("X-Apicc-Share-Key"),"view",download,null)){
                        body=admission.body();if(download)headers.set("Content-Disposition","attachment; filename=\"apicc-publication-"+admission.version()+".json\"");
                        headers.set("X-Apicc-Download-Allowed",Boolean.toString(admission.downloadAllowed()));headers.set("X-Apicc-Publication-Version",Long.toString(admission.version()));
                        headers.set("Content-Type","application/json; charset=utf-8");exchange.sendResponseHeaders(200,body.length);exchange.getResponseBody().write(body);
                        observations.read(admission,download);
                    }
                    return;
                }else if(mock){
                    String id=path.substring("/mock/".length()).split("/")[0];
                    try(var admission=grants.admit(id,exchange.getRequestHeaders().getFirst("X-Apicc-Mock-Key"),"call",false,exchange.getRequestHeaders().getFirst("Authorization"))){mockGateway.serve(exchange,id,admission);}
                    return;
                }else {body=viewer.index();headers.set("Content-Security-Policy",viewer.shellCsp());}
                headers.set("Content-Type",data?"application/json; charset=utf-8":"text/html; charset=utf-8");exchange.sendResponseHeaders(200,body.length);exchange.getResponseBody().write(body);
            }catch(ApiException failure){
                Object error=failure instanceof ShareInactive inactive?java.util.Map.of("code",failure.getCode(),"reason",inactive.reason(),"message",failure.getMessage()):java.util.Map.of("code",failure.getCode(),"message",failure.getMessage());
                byte[] body=json.writeValueAsBytes(error);exchange.getResponseHeaders().set("Content-Type","application/json; charset=utf-8");exchange.sendResponseHeaders(failure.getStatus().value(),body.length);exchange.getResponseBody().write(body);
            }catch(Exception failure){byte[] body="{\"code\":\"internal_error\"}".getBytes(StandardCharsets.UTF_8);exchange.sendResponseHeaders(500,body.length);exchange.getResponseBody().write(body);}
            finally{exchange.close();}
        },active::remove,()->session.close(org.apache.hc.core5.io.CloseMode.IMMEDIATE));owned.setAttribute("absoluteRequestTarget",transport.absolute());active.add(owned);return owned;}).create();
        server.start();
        address=(InetSocketAddress)server.listen(new InetSocketAddress(properties.getBindAddress(),properties.getPort()),org.apache.hc.core5.http.URIScheme.HTTP).get().getAddress();
    }
    public String origin(){return "http://127.0.0.1:"+address.getPort();}
    public Integer boundPort(){return address==null?null:address.getPort();}
    private void preflight(com.sun.net.httpserver.HttpExchange exchange)throws Exception {
        // The platform ceiling is independent of publicId, project, grant and publication existence.
        var policy=policies.publicationSnapshot(0,0);
        try(var lease=mockLimits.acquireGlobal(policy)){
            long bytes=exchange.getRequestHeaders().entrySet().stream().mapToLong(field->field.getKey().getBytes(StandardCharsets.UTF_8).length+field.getValue().stream().mapToLong(value->value.getBytes(StandardCharsets.UTF_8).length).sum()).sum();
            if(bytes>com.autumnharvestc.server.collaboration.artifacts.CollaborationStorage.number(policy,com.autumnharvestc.server.collaboration.policy.PolicyReadView.Code.MAX_MOCK_REQUEST_BYTES))throw new ApiException(org.springframework.http.HttpStatus.PAYLOAD_TOO_LARGE,"mock_request_size_limit","Mock 请求超过字节上限");
            String origin=exchange.getRequestHeaders().getFirst("Origin"),method=exchange.getRequestHeaders().getFirst("Access-Control-Request-Method"),requested=exchange.getRequestHeaders().getFirst("Access-Control-Request-Headers");
            var origins=(com.autumnharvestc.server.collaboration.policy.PolicyReadView.StringListSetting)policy.settings().stream().filter(setting->setting.code()==com.autumnharvestc.server.collaboration.policy.PolicyReadView.Code.CORS_ALLOWED_ORIGINS).findFirst().orElseThrow();
            boolean valid=origins.effective().contains(origin)&&java.util.Set.of("GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS").contains(method);
            var names=new java.util.ArrayList<String>();
            if(requested!=null)for(String part:requested.split(",",-1)){String name=part.trim();valid&=name.matches("[!#$%&'*+.^_`|~0-9A-Za-z-]+");names.add(name);}
            if(!valid)throw new ApiException(org.springframework.http.HttpStatus.FORBIDDEN,"mock_preflight_forbidden","预检来源、方法或请求头名不受允许");
            var headers=exchange.getResponseHeaders();headers.set("Access-Control-Allow-Origin",origin);headers.set("Vary","Origin, Access-Control-Request-Method, Access-Control-Request-Headers");headers.set("Access-Control-Allow-Methods",method);if(requested!=null)headers.set("Access-Control-Allow-Headers",String.join(", ",names));
            exchange.sendResponseHeaders(204,-1);exchange.getResponseBody().close();
        }
    }
    public boolean running(){return server!=null;}
    @PreDestroy public void close(){executor.shutdownNow();for(var exchange:active)exchange.failed(new java.io.IOException("Public service stopping"));if(server!=null){server.close(org.apache.hc.core5.io.CloseMode.IMMEDIATE);server=null;}sessions.clear();requestTransports.clear();executor.close();}
}
