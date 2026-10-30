package com.autumnharvestc.server.execution.notifications;
public record DeliveryResult(String reasonCode,Integer status,java.time.Instant retryAfter,boolean acknowledged) {}
