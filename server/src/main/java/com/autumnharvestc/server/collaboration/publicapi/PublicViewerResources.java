package com.autumnharvestc.server.collaboration.publicapi;

import com.autumnharvestc.server.core.ApiException;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.springframework.http.HttpStatus;

/** Only operator-installed fixed viewer files, separate from console-dir and the servlet resource chain. */
public class PublicViewerResources {
    private final PublicAccessProperties properties;
    public PublicViewerResources(PublicAccessProperties properties){this.properties=properties;}

    public byte[] index(){
        // A shell must not claim success with an incomplete installation.
        read("viewer.js");read("viewer.css");
        return read("index.html");
    }
    public byte[] script(){return read("viewer.js");}
    public byte[] style(){return read("viewer.css");}
    private byte[] read(String fixedName){
        try{return Files.readAllBytes(Path.of(properties.getViewerDir()).toAbsolutePath().normalize().resolve(fixedName));}
        catch(IOException failure){throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE,"share_viewer_unavailable","只读查看器尚未部署，请联系服务管理员");}
    }
    public String shellCsp(){
        String origin=properties.getBaseUrl().replaceAll("/$","");
        return "default-src 'none'; script-src "+origin+"/share-viewer/viewer.js; style-src "+origin+"/share-viewer/viewer.css; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
    }
}
