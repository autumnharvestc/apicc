package com.autumnharvestc.server.execution.notifications;
@org.springframework.context.annotation.Configuration
public class NotificationTransportConfiguration {
    @org.springframework.context.annotation.Bean(destroyMethod="close")
    public ApacheWebhookTransport notificationTransport(com.autumnharvestc.server.execution.scheduling.NotificationProperties properties,NotificationChannelRepo channels){return new ApacheWebhookTransport(properties,java.net.InetAddress::getAllByName,c->channels.activeVersion(c.id(),c.version()));}
}
