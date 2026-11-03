package com.autumnharvestc.server.collaboration.publicapi;

import com.sun.net.httpserver.*;
import java.io.*;
import java.net.*;
import java.nio.ByteBuffer;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.apache.hc.core5.http.*;
import org.apache.hc.core5.http.message.BasicHttpResponse;
import org.apache.hc.core5.http.nio.*;
import org.apache.hc.core5.http.nio.entity.BasicAsyncEntityProducer;
import org.apache.hc.core5.http.nio.support.BasicResponseProducer;
import org.apache.hc.core5.http.protocol.HttpCoreContext;

/** HttpCore transport adapter. The virtual worker owns business admission until actual exchange collection. */
final class PublicExchange extends HttpExchange implements AsyncServerExchangeHandler {
    private final ExecutorService executor;private final HttpHandler handler;
    private final java.util.function.Consumer<PublicExchange> finished;
    private final Runnable cancelTransport;
    private final Headers requestHeaders=new Headers(),responseHeaders=new Headers();
    private final Map<String,Object> attributes=new ConcurrentHashMap<>();
    private final CountDownLatch capacityReady=new CountDownLatch(1),collected=new CountDownLatch(1);
    private final BlockingQueue<byte[]> chunks=new LinkedBlockingQueue<>();private static final byte[] END=new byte[0];
    private final AtomicReference<Thread> worker=new AtomicReference<>();private final AtomicBoolean failed=new AtomicBoolean(),sent=new AtomicBoolean();
    private volatile CapacityChannel capacity;private volatile boolean ended;
    private org.apache.hc.core5.http.HttpRequest request;private ResponseChannel channel;private org.apache.hc.core5.http.protocol.HttpContext context;
    private volatile BasicResponseProducer producer;private volatile int status=-1;private long responseLength;
    private final ByteArrayOutputStream output=new ByteArrayOutputStream();
    private byte[] current;private int offset;
    PublicExchange(ExecutorService executor,HttpHandler handler,java.util.function.Consumer<PublicExchange> finished,Runnable cancelTransport){this.executor=executor;this.handler=handler;this.finished=finished;this.cancelTransport=cancelTransport;}
    @Override public void handleRequest(org.apache.hc.core5.http.HttpRequest request,EntityDetails entity,ResponseChannel channel,org.apache.hc.core5.http.protocol.HttpContext context){
        this.request=request;this.channel=channel;this.context=context;for(var header:request.getHeaders())requestHeaders.add(header.getName(),header.getValue());
        if(entity==null){ended=true;chunks.offer(END);capacityReady.countDown();}
        executor.execute(()->{worker.set(Thread.currentThread());try{if(!failed.get())handler.handle(this);}catch(IOException connection){failed.set(true);}finally{close();worker.set(null);finished.accept(this);}});
    }
    @Override public void updateCapacity(CapacityChannel channel){capacity=channel;capacityReady.countDown();}
    @Override public void consume(ByteBuffer buffer){byte[] bytes=new byte[buffer.remaining()];buffer.get(bytes);chunks.offer(bytes);}
    @Override public void streamEnd(List<? extends Header> trailers){ended=true;chunks.offer(END);}
    @Override public int available(){var value=producer;return value==null?0:value.available();}
    @Override public void produce(DataStreamChannel channel)throws IOException{var value=producer;if(value!=null)value.produce(channel);}
    @Override public void failed(Exception error){failed.set(true);chunks.offer(END);capacityReady.countDown();var thread=worker.get();if(thread!=null)thread.interrupt();}
    @Override public void releaseResources(){var value=producer;if(value!=null)value.releaseResources();collected.countDown();}
    private void submit()throws IOException{
        if(!sent.compareAndSet(false,true)||failed.get())return;
        var response=new BasicHttpResponse(status<0?500:status);responseHeaders.forEach((name,values)->values.forEach(value->response.addHeader(name,value)));
        // An early rejection must not wait for an untrusted unfinished body.
        if(!ended)response.setHeader("Connection","close");
        producer=responseLength<0?new BasicResponseProducer(response):new BasicResponseProducer(response,new BasicAsyncEntityProducer(output.toByteArray()));
        try{producer.sendResponse(channel,context);collected.await();}
        catch(InterruptedException cancelled){
            // Interrupting the owner is not collection: the submitted response still belongs to I/O.
            cancelTransport.run();
            while(collected.getCount()!=0){try{collected.await();}catch(InterruptedException stillCancelling){/* retain ownership until framework releaseResources */}}
            Thread.currentThread().interrupt();throw new IOException("Public exchange cancelled",cancelled);
        }catch(HttpException invalid){throw new IOException("Public response invalid",invalid);}
    }
    @Override public InputStream getRequestBody(){return new InputStream(){
        @Override public int read()throws IOException{byte[] one=new byte[1];return read(one,0,1)<0?-1:Byte.toUnsignedInt(one[0]);}
        @Override public int read(byte[] bytes,int start,int length)throws IOException{
            if(length==0)return 0;
            try{
                while(current==null||offset==current.length){
                    if(failed.get())throw new IOException("Public request cancelled");
                    if(ended&&chunks.isEmpty())return -1;
                    if(!ended)capacityReady.await();if(failed.get())throw new IOException("Public request cancelled");
                    if(!ended&&capacity!=null)capacity.update(8192);
                    current=chunks.take();offset=0;if(current==END)return -1;
                }
                int count=Math.min(length,current.length-offset);System.arraycopy(current,offset,bytes,start,count);offset+=count;return count;
            }catch(InterruptedException cancelled){Thread.currentThread().interrupt();throw new IOException("Public request cancelled");}
        }
    };}
    @Override public OutputStream getResponseBody(){return new OutputStream(){
        @Override public void write(int value)throws IOException{write(new byte[]{(byte)value});}
        @Override public void write(byte[] bytes,int offset,int length)throws IOException{if(failed.get())throw new IOException("Public response cancelled");output.write(bytes,offset,length);if(output.size()>=responseLength)submit();}
        @Override public void close()throws IOException{submit();}
    };}
    @Override public void close(){try{if(!failed.get())submit();}catch(IOException connection){failed.set(true);}}
    @Override public Headers getRequestHeaders(){return requestHeaders;}
    @Override public Headers getResponseHeaders(){return responseHeaders;}
    @Override public URI getRequestURI(){return URI.create(request.getRequestUri());}
    @Override public String getRequestMethod(){return request.getMethod();}
    @Override public void sendResponseHeaders(int code,long length){status=code;responseLength=length;}
    @Override public int getResponseCode(){return status;}
    @Override public String getProtocol(){return request.getVersion()==null?"HTTP/1.1":request.getVersion().toString();}
    @Override public InetSocketAddress getRemoteAddress(){return (InetSocketAddress)HttpCoreContext.cast(context).getEndpointDetails().getRemoteAddress();}
    @Override public InetSocketAddress getLocalAddress(){return (InetSocketAddress)HttpCoreContext.cast(context).getEndpointDetails().getLocalAddress();}
    @Override public Object getAttribute(String name){return attributes.get(name);}
    @Override public void setAttribute(String name,Object value){attributes.put(name,value);}
    @Override public com.sun.net.httpserver.HttpContext getHttpContext(){return null;}
    @Override public void setStreams(InputStream input,OutputStream output){throw new UnsupportedOperationException();}
    @Override public HttpPrincipal getPrincipal(){return null;}
}
