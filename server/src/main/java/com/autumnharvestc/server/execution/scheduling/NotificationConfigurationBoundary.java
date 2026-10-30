package com.autumnharvestc.server.execution.scheduling;

import java.net.*;

/** Syntax only. T5 transport must re-resolve and enforce address policy before every connection. */
final class NotificationConfigurationBoundary {
    private NotificationConfigurationBoundary() {}
    static boolean origin(String value) {
        try {
            var u=new URI(value);String scheme=u.getScheme();
            if(!"http".equals(scheme)&&!"https".equals(scheme)||u.getHost()==null||u.getUserInfo()!=null||u.getQuery()!=null||u.getFragment()!=null||!"".equals(u.getPath()))return false;
            return value.equals(NotificationOrigin.canonical(u));
        }catch(Exception e){return false;}
    }
    static boolean cidr(String value) {
        try {
            String[] parts=value.split("/",-1);if(parts.length!=2||!parts[1].matches("[0-9]+"))return false;
            int prefix=Integer.parseInt(parts[1]);
            if(parts[0].contains(":"))return parts[0].matches("[0-9a-fA-F:]+")&&InetAddress.getByName(parts[0]) instanceof Inet6Address&&prefix<=128;
            String[] octets=parts[0].split("\\.",-1);if(octets.length!=4||prefix>32)return false;
            for(String octet:octets)if(!octet.matches("0|[1-9][0-9]{0,2}")||Integer.parseInt(octet)>255)return false;
            return true;
        }catch(Exception ex){return false;}
    }
}
