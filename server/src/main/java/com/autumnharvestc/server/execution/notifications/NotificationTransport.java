package com.autumnharvestc.server.execution.notifications;
public interface NotificationTransport {
    DeliveryResult send(DeliveryChannel channel,byte[] fixedBody,String eventId,java.time.Instant deliveryTimestamp,NotificationLimits limits);
}
