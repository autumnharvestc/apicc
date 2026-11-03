package com.autumnharvestc.server.collaboration.artifacts;

import com.autumnharvestc.server.core.ApiException;
import org.springframework.http.HttpStatus;
import java.io.*;
import java.nio.charset.StandardCharsets;

/** Application-side source streaming budget; not a JDBC-driver or process RSS limit. */
public final class SourceByteBudget {
    private final long maximum;
    private long used;
    public SourceByteBudget(long maximum){this.maximum=maximum;}
    public long used(){return used;}
    private void charge(int bytes) {
        if(bytes>maximum-used)throw new ApiException(HttpStatus.BAD_REQUEST,"source_size_limit","来源实际字节数超过本次发布上限");
        used+=bytes;
    }
    /** One encoder per complete file preserves surrogate state across reader chunks and final close. */
    public String readText(Reader input)throws IOException {
        var text=new StringBuilder();
        var counter=new OutputStream() {
            @Override public void write(int value){charge(1);}
            @Override public void write(byte[] bytes,int offset,int length){charge(length);}
        };
        try(input;var utf8=new OutputStreamWriter(counter,StandardCharsets.UTF_8)) {
            char[] buffer=new char[4096];int count;
            while((count=input.read(buffer))!=-1) {
                utf8.write(buffer,0,count);utf8.flush();
                text.append(buffer,0,count);
            }
        }
        return text.toString();
    }
    /** The stream is fully consumed or rejected before the row/transaction is released. */
    public static byte[] readBinary(InputStream input,long maximum)throws IOException {
        if(input==null)return null; // Existing archived-body-missing semantics remain with the source reader.
        var budget=new SourceByteBudget(maximum);
        try(input;var output=new ByteArrayOutputStream()) {
            byte[] buffer=new byte[8192];int count;
            while((count=input.read(buffer,0,(int)Math.min(buffer.length,maximum-budget.used+1)))!=-1) {
                budget.charge(count);output.write(buffer,0,count);
            }
            return output.toByteArray();
        }
    }
}
