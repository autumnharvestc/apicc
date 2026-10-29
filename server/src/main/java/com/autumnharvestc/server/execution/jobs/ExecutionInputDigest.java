package com.autumnharvestc.server.execution.jobs;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.*;
import java.util.*;

/** Matches executionInputsDigestText's sort -> Object.fromEntries -> JSON.stringify.
 * Deliberately used only for fixed execution inputs, never existing intent/receipt identities. */
final class ExecutionInputDigest {
    private ExecutionInputDigest() {}
    static String text(JsonNode value){var output=new StringBuilder();write(value,output);return output.toString();}
    private static void write(JsonNode value,StringBuilder out){
        if(value.isObject()){
            var keys=new ArrayList<String>();value.fieldNames().forEachRemaining(keys::add);
            keys.sort((a,b)->{long x=index(a),y=index(b);return x>=0?(y>=0?Long.compare(x,y):-1):y>=0?1:a.compareTo(b);});
            out.append('{');boolean next=false;for(String key:keys){if(next)out.append(',');next=true;quote(key,out);out.append(':');write(value.get(key),out);}out.append('}');
        }else if(value.isArray()){
            out.append('[');boolean next=false;for(var item:value){if(next)out.append(',');next=true;write(item,out);}out.append(']');
        }else if(value.isTextual())quote(value.textValue(),out);
        else if(value.isNumber())out.append(number(value.doubleValue()));
        else out.append(value.toString());
    }
    private static long index(String key){
        if(!key.matches("0|[1-9][0-9]{0,9}"))return -1;
        long value=Long.parseLong(key);return value<=4294967294L?value:-1;
    }
    private static void quote(String value,StringBuilder out){
        out.append('"');
        for(int i=0;i<value.length();i++){
            char c=value.charAt(i);
            switch(c){case '"'->out.append("\\\"");case '\\'->out.append("\\\\");case '\b'->out.append("\\b");case '\t'->out.append("\\t");case '\n'->out.append("\\n");case '\f'->out.append("\\f");case '\r'->out.append("\\r");default->{
                boolean unpaired=Character.isHighSurrogate(c)?i+1==value.length()||!Character.isLowSurrogate(value.charAt(i+1)):Character.isLowSurrogate(c)&&(i==0||!Character.isHighSurrogate(value.charAt(i-1)));
                if(c<32||unpaired){out.append("\\u");String hex=Integer.toHexString(c);out.append("0".repeat(4-hex.length())).append(hex);}else out.append(c);
            }}
        }
        out.append('"');
    }
    /** ECMA shortest, closest decimal representation; ties choose an even significand.
     * BigDecimal(double) is the exact binary value, not Double.toString's approximation.
     * Test the nearest decimal and its two neighbours at each precision because a binary
     * power-of-two's round-trip interval need not be symmetric. At most 17 digits suffice. */
    private static String number(double value){
        if(!Double.isFinite(value))throw new IllegalArgumentException("Execution input numbers must be finite");
        if(value==0)return "0";
        var exact=new BigDecimal(Math.abs(value));int exponent=exact.precision()-exact.scale()-1;
        BigDecimal chosen=null;
        for(int digits=1;digits<=17&&chosen==null;digits++){
            int scale=digits-1-exponent;var nearest=exact.setScale(scale,RoundingMode.HALF_EVEN);var unit=BigDecimal.ONE.scaleByPowerOfTen(-scale);
            for(int step=-1;step<=1;step++){
                var candidate=nearest.add(unit.multiply(BigDecimal.valueOf(step))).stripTrailingZeros();
                if(candidate.signum()<=0||candidate.precision()>digits||candidate.doubleValue()!=Math.abs(value))continue;
                if(chosen==null){chosen=candidate;continue;}
                int distance=candidate.subtract(exact).abs().compareTo(chosen.subtract(exact).abs());
                if(distance<0||distance==0&&!candidate.unscaledValue().testBit(0))chosen=candidate;
            }
        }
        if(chosen==null)throw new IllegalStateException("Finite double has no decimal representation");
        exponent=chosen.precision()-chosen.scale()-1;String result;
        if(exponent>=-6&&exponent<21)result=chosen.toPlainString();
        else {String digits=chosen.unscaledValue().toString();result=digits.substring(0,1)+(digits.length()>1?"."+digits.substring(1):"")+"e"+(exponent>=0?"+":"")+exponent;}
        return value<0?"-"+result:result;
    }
}
