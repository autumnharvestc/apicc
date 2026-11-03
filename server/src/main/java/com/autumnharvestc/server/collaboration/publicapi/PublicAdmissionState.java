package com.autumnharvestc.server.collaboration.publicapi;

import org.springframework.stereotype.Component;

@Component
public class PublicAdmissionState {
    private volatile boolean ready;
    public boolean ready(){return ready;}
    public void close(){ready=false;}
    public void reconciled(){ready=true;}
}
