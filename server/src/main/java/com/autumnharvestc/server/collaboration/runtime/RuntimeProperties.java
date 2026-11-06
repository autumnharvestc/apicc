package com.autumnharvestc.server.collaboration.runtime;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/** Deployment settings only; no project/request-selected runtime addresses. */
@Component
@ConfigurationProperties(prefix="apicc.collaboration.runtime")
public class RuntimeProperties {
    private boolean enabled;
    private String baseUrl = "", secretFile = "";
    private int connectTimeoutMs=3000, callTimeoutMs=10000, mockTimeoutMs=35000, sourceReadTimeoutMaxMs=1800000, maxWireBytes=33_554_432;
    public boolean isEnabled(){return enabled;} public void setEnabled(boolean value){enabled=value;}
    public String getBaseUrl(){return baseUrl;} public void setBaseUrl(String value){baseUrl=value;}
    public String getSecretFile(){return secretFile;} public void setSecretFile(String value){secretFile=value;}
    public int getConnectTimeoutMs(){return connectTimeoutMs;} public void setConnectTimeoutMs(int value){connectTimeoutMs=value;}
    public int getCallTimeoutMs(){return callTimeoutMs;} public void setCallTimeoutMs(int value){callTimeoutMs=value;}
    public int getMockTimeoutMs(){return mockTimeoutMs;} public void setMockTimeoutMs(int value){mockTimeoutMs=value;}
    public int getSourceReadTimeoutMaxMs(){return sourceReadTimeoutMaxMs;} public void setSourceReadTimeoutMaxMs(int value){sourceReadTimeoutMaxMs=value;}
    public int getMaxWireBytes(){return maxWireBytes;} public void setMaxWireBytes(int value){maxWireBytes=value;}
    public void requireValid(){
        if(connectTimeoutMs<100||connectTimeoutMs>30000||callTimeoutMs<1000||callTimeoutMs>300000||mockTimeoutMs<1000||mockTimeoutMs>120000||sourceReadTimeoutMaxMs<1000||sourceReadTimeoutMaxMs>1800000||maxWireBytes<1_048_576||maxWireBytes>134_217_728)throw new IllegalArgumentException("RPC_CONFIGURATION_INVALID");
    }
}
