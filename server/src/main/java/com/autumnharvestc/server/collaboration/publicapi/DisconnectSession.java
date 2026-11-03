package com.autumnharvestc.server.collaboration.publicapi;

import java.io.IOException;
import java.net.SocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ByteChannel;
import java.util.concurrent.locks.Lock;
import org.apache.hc.core5.io.CloseMode;
import org.apache.hc.core5.reactor.*;
import org.apache.hc.core5.util.Timeout;

/** Public HTTP does not accept half-closed request connections while work is pending.
 * Close on actual socket EOF so HttpCore fails/releases the exchange even before response output. */
public final class DisconnectSession implements IOSession {
    private final IOSession delegate;
    public DisconnectSession(IOSession delegate){this.delegate=delegate;}
    @Override public int read(ByteBuffer buffer)throws IOException {int count=delegate.read(buffer);if(count<0)delegate.close(CloseMode.IMMEDIATE);return count;}
    @Override public int write(ByteBuffer buffer)throws IOException{return delegate.write(buffer);}
    @Override public ByteChannel channel(){return this;}
    @Override public boolean isOpen(){return delegate.isOpen();}
    @Override public void close(){delegate.close();}
    @Override public void close(CloseMode mode){delegate.close(mode);}
    @Override public String getId(){return delegate.getId();}
    @Override public IOEventHandler getHandler(){return delegate.getHandler();}
    @Override public void upgrade(IOEventHandler handler){delegate.upgrade(handler);}
    @Override public Lock getLock(){return delegate.getLock();}
    @Override public void enqueue(Command command,Command.Priority priority){delegate.enqueue(command,priority);}
    @Override public boolean hasCommands(){return delegate.hasCommands();}
    @Override public Command poll(){return delegate.poll();}
    @Override public SocketAddress getRemoteAddress(){return delegate.getRemoteAddress();}
    @Override public SocketAddress getLocalAddress(){return delegate.getLocalAddress();}
    @Override public int getEventMask(){return delegate.getEventMask();}
    @Override public void setEventMask(int value){delegate.setEventMask(value);}
    @Override public void setEvent(int value){delegate.setEvent(value);}
    @Override public void clearEvent(int value){delegate.clearEvent(value);}
    @Override public Status getStatus(){return delegate.getStatus();}
    @Override public Timeout getSocketTimeout(){return delegate.getSocketTimeout();}
    @Override public void setSocketTimeout(Timeout value){delegate.setSocketTimeout(value);}
    @Override public long getLastReadTime(){return delegate.getLastReadTime();}
    @Override public long getLastWriteTime(){return delegate.getLastWriteTime();}
    @Override public long getLastEventTime(){return delegate.getLastEventTime();}
    @Override public void updateReadTime(){delegate.updateReadTime();}
    @Override public void updateWriteTime(){delegate.updateWriteTime();}
}
