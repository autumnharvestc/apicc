package com.autumnharvestc.server.store;

import com.zaxxer.hikari.HikariDataSource;
import java.sql.Connection;
import java.util.ArrayList;
import java.util.Locale;
import javax.sql.DataSource;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Configure the bound datasource before schema initialization or any application consumer. */
@Configuration(proxyBeanMethods=false)
public class MetadataDurabilityConfiguration {
    @Bean static BeanPostProcessor metadataDurability() {
        return new BeanPostProcessor() {
            @Override public Object postProcessAfterInitialization(Object bean, String name) {
                if (!(bean instanceof DataSource source)) return bean;
                try {
                // Alternate physical sources can ignore jdbcUrl (even a decoy in-memory URL).
                // Identify those through the actual connection below, before classifying by URL.
                if (source instanceof HikariDataSource pool && pool.getJdbcUrl()!=null
                    && pool.getDataSource()==null && pool.getDataSourceClassName()==null) {
                    String url=pool.getJdbcUrl();
                    if (!url.startsWith("jdbc:h2:") || url.startsWith("jdbc:h2:mem:")) return bean;
                    if (pool.getHikariPoolMXBean()!=null) throw unsafe("pool already started; configure an unstarted Hikari datasource");
                    if (pool.getConnectionInitSql()!=null && !pool.getConnectionInitSql().isBlank())
                        throw unsafe("custom connection-init-sql is unsupported; remove it for persistent H2");
                    if (pool.getConnectionTestQuery()!=null && !pool.getConnectionTestQuery().isBlank())
                        throw unsafe("custom connection-test-query is unsupported; remove it and use JDBC isValid for persistent H2");
                    for (Object key: pool.getDataSourceProperties().keySet())
                        if (key.toString().equalsIgnoreCase("INIT")) throw unsafe("datasource INIT is unsupported; remove it for persistent H2");
                    pool.setJdbcUrl(zeroDelayUrl(url));
                    for (Object key: pool.getDataSourceProperties().keySet())
                        if (key.toString().equalsIgnoreCase("WRITE_DELAY")) pool.getDataSourceProperties().put(key,"0");
                    // Hikari runs this successfully on EVERY new physical connection before exposure.
                    pool.setConnectionInitSql("SET WRITE_DELAY 0");
                    return bean;
                }
                // Custom/non-H2 datasources: identify through JDBC, never send H2 SQL to another DB.
                try (Connection connection=source.getConnection()) {
                    if (!connection.getMetaData().getDatabaseProductName().equals("H2")) return bean;
                    try (var statement=connection.createStatement();var rows=statement.executeQuery("CALL DATABASE_PATH()")) {
                        rows.next(); if (rows.getString(1)==null) return bean;
                    }
                } catch (java.sql.SQLException failure) {
                    // Driver messages may contain credentials or a complete JDBC URL.
                    throw unsafe("cannot identify custom datasource safely; use an unstarted Hikari datasource");
                }
                throw unsafe("persistent custom datasource is unsupported; use an unstarted Hikari datasource with jdbc-url");
                } catch (IllegalStateException failure) {
                    // A bean rejected during post-processing is not yet registered for destruction.
                    if (source instanceof HikariDataSource pool) pool.close();
                    throw failure;
                }
            }
        };
    }

    private static IllegalStateException unsafe(String detail) {
        return new IllegalStateException("metadata durability: "+detail);
    }

    private static String zeroDelayUrl(String url) {
        // H2 separates the path before decoding the settings; preserve the path verbatim.
        int separator=url.indexOf(';');
        String base=separator<0?url:url.substring(0,separator);
        String settings=separator<0?"":url.substring(separator+1);
        var parts=new ArrayList<String>(); int start=0;
        for (int i=0;i<settings.length();i++) {
            if (settings.charAt(i)=='\\') {i++;continue;}
            if (settings.charAt(i)==';') {parts.add(settings.substring(start,i));start=i+1;}
        }
        parts.add(settings.substring(start));
        // Put the policy first: a valid final raw backslash must remain final, not eat our ';'.
        var result=new ArrayList<String>();result.add(base);result.add("WRITE_DELAY=0");
        for (String part:parts) {
            // Pinned H2 decodes ANY escaped next character before identifying the key.
            var decoded=new StringBuilder();
            for (int i=0;i<part.length();i++) {
                if (part.charAt(i)=='\\' && i+1<part.length())i++;
                decoded.append(part.charAt(i));
            }
            int equals=decoded.indexOf("=");
            String key=(equals<0?decoded.toString():decoded.substring(0,equals)).toUpperCase(Locale.ROOT);
            if (key.equals("INIT")) throw unsafe("URL INIT is unsupported; remove it for persistent H2");
            if (!key.equals("WRITE_DELAY") && !part.isEmpty()) result.add(part);
        }
        return String.join(";",result);
    }
}
