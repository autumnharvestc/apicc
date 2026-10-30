package com.autumnharvestc.server.execution.notifications;
/** Ephemeral send-only secrets. Never serialize or persist this record. */
public record DeliveryChannel(String id,String version,java.net.URI uri,byte[] hmacSecret) {
    @Override public String toString(){return "DeliveryChannel[redacted]";}
}
