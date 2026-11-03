package com.autumnharvestc.server.collaboration.publicapi;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Component
@ConfigurationProperties(prefix="apicc.collaboration.public-access")
public class PublicAccessProperties {
    private boolean enabled;
    private String bindAddress="127.0.0.1";
    private int port;
    private String baseUrl="";
    private String managementBaseUrl="";
    private String viewerDir="./share-viewer";
    public String getViewerDir(){return viewerDir;}
    public void setViewerDir(String value){viewerDir=value;}
    public boolean isEnabled(){return enabled;}
    public void setEnabled(boolean value){enabled=value;}
    public String getBindAddress(){return bindAddress;}
    public void setBindAddress(String value){bindAddress=value;}
    public int getPort(){return port;}
    public void setPort(int value){port=value;}
    public String getBaseUrl(){return baseUrl;}
    public void setBaseUrl(String value){baseUrl=value;}
    public String getManagementBaseUrl(){return managementBaseUrl;}
    public void setManagementBaseUrl(String value){managementBaseUrl=value;}
    /** Only deployment values determine URLs; request Host/forwarded headers are never consulted. */
    public boolean configured(int managementPort){
        return enabled&&savedOriginsValid(managementPort);
    }
    /** Saved non-secret origin validity is distinct from listener enable/admission. */
    public boolean savedOriginsValid(int managementPort){
        try{
            var publicUri=origin(baseUrl);
            boolean local=loopback(publicUri.getHost());
            if(publicUri.getScheme().equals("http")){
                if(!local||!loopback(bindAddress))return false;
                if(effectivePort(publicUri)==managementPort)return false;
            }else if(!publicUri.getScheme().equals("https"))return false;
            if(!local||publicUri.getScheme().equals("https")){
                var management=origin(managementBaseUrl);
                if(!management.getScheme().equals("https")||same(publicUri,management))return false;
            }
            return true;
        }catch(IllegalArgumentException invalid){return false;}
    }
    /** Do not disclose even an optional origin containing credentials or non-origin components. */
    public static String safeSavedOrigin(String value){
        if(value==null||value.isBlank())return null;
        try{var uri=origin(value);return uri.getScheme().equals("http")||uri.getScheme().equals("https")?value:null;}catch(IllegalArgumentException invalid){return null;}
    }
    private static java.net.URI origin(String value){
        var uri=java.net.URI.create(value);
        if(uri.getScheme()==null||uri.getHost()==null||uri.getUserInfo()!=null||uri.getQuery()!=null||uri.getFragment()!=null||(!uri.getRawPath().isEmpty()&&!uri.getRawPath().equals("/"))||uri.getPort()==0)throw new IllegalArgumentException("Invalid origin");
        return uri;
    }
    private static boolean loopback(String host){return SetHolder.LOCAL.contains(host.toLowerCase(java.util.Locale.ROOT));}
    private static boolean same(java.net.URI left,java.net.URI right){return left.getScheme().equalsIgnoreCase(right.getScheme())&&left.getHost().equalsIgnoreCase(right.getHost())&&effectivePort(left)==effectivePort(right);}
    private static int effectivePort(java.net.URI uri){return uri.getPort()<0?(uri.getScheme().equalsIgnoreCase("https")?443:80):uri.getPort();}
    private static final class SetHolder {static final java.util.Set<String> LOCAL=java.util.Set.of("127.0.0.1","localhost","::1","[::1]");}
}
