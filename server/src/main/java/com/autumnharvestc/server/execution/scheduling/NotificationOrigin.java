package com.autumnharvestc.server.execution.scheduling;

import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.util.Locale;

/** Origin representation only: never rebuilds an endpoint or resolves a DNS name. */
public final class NotificationOrigin {
    private NotificationOrigin() {}

    public static String canonical(URI uri) {
        String scheme=uri.getScheme(),host=uri.getHost();int port=uri.getPort();
        if(!"http".equals(scheme)&&!"https".equals(scheme)||host==null||uri.getUserInfo()!=null||uri.getFragment()!=null||port==0||port>65535)
            throw unsupported();
        host=host.toLowerCase(Locale.ROOT);
        if(host.startsWith("["))host=ipv6(host);
        else {
            // Initial notification endpoints support ASCII DNS, not IDNA.
            // This is a support boundary, not a claim that valid ACE is unsafe.
            for(String label:host.split("\\."))if(label.startsWith("xn--"))throw unsupported();
            String candidate=host.endsWith(".")?host.substring(0,host.length()-1):host;
            String last=candidate.substring(candidate.lastIndexOf('.')+1);
            // WHATWG treats numeric final labels as IPv4, not DNS. Do not accept
            // alternate octal/hex/abbreviated representations as deployment names.
            if(last.matches("[0-9]+|0x[0-9a-f]*")&&!ipv4(host))throw unsupported();
        }
        return scheme+"://"+host+(port<0||port==("https".equals(scheme)?443:80)?"":":"+port);
    }

    private static boolean ipv4(String host) {
        String[] parts=host.split("\\.",-1);if(parts.length!=4)return false;
        for(String part:parts)if(!part.matches("0|[1-9][0-9]{0,2}")||Integer.parseInt(part)>255)return false;
        return true;
    }

    private static String ipv6(String host) {
        // URI already checked the IPv6 structure. Exclude zones and any name
        // characters before the JDK's literal-only address parser is called.
        if(!host.matches("\\[[0-9a-f:.]+\\]"))throw unsupported();
        if(host.indexOf('.')>=0&&!ipv4(host.substring(host.lastIndexOf(':')+1,host.length()-1)))throw unsupported();
        byte[] bytes;
        try{bytes=InetAddress.getByName(host).getAddress();}catch(UnknownHostException e){throw unsupported();}
        if(bytes.length==4){ // JDK represents IPv4-mapped IPv6 literals as Inet4Address.
            byte[] mapped=new byte[16];mapped[10]=(byte)255;mapped[11]=(byte)255;System.arraycopy(bytes,0,mapped,12,4);bytes=mapped;
        }
        int[] pieces=new int[8];for(int i=0;i<8;i++)pieces[i]=((bytes[i*2]&255)<<8)|(bytes[i*2+1]&255);
        int start=-1,length=1;
        for(int i=0;i<8;){if(pieces[i]!=0){i++;continue;}int end=i;while(end<8&&pieces[end]==0)end++;if(end-i>length){start=i;length=end-i;}i=end;}
        var result=new StringBuilder("[");
        for(int i=0;i<8;){
            if(i==start){result.append("::");i+=length;continue;}
            if(result.length()>1&&result.charAt(result.length()-1)!=':')result.append(':');
            result.append(Integer.toHexString(pieces[i++]));
        }
        return result.append(']').toString();
    }

    private static IllegalArgumentException unsupported(){return new IllegalArgumentException("Unsupported notification origin");}
}
