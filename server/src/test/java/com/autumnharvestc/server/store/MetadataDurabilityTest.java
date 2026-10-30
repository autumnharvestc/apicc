package com.autumnharvestc.server.store;

import com.autumnharvestc.server.ApiccServerApplication;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.nio.file.*;
import java.sql.*;
import java.util.*;
import javax.sql.DataSource;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.Environment;
import org.springframework.core.io.*;
import org.springframework.beans.factory.config.YamlPropertiesFactoryBean;
import static org.assertj.core.api.Assertions.*;

/** Regression: an ACK-capable persistent connection must never start with delayed writes. */
public class MetadataDurabilityTest {
    @TempDir Path root;
    private static final List<HikariDataSource> customPools=new ArrayList<>();
    @AfterEach void closeCustomPools(){customPools.forEach(HikariDataSource::close);customPools.clear();}

    // An omitted shipped URL option must fail on the actual new database, not on a text search.
    @ParameterizedTest @ValueSource(strings={"java","docker","k8s"})
    void shippedDefaultsOpenAnActuallyZeroDelayPersistentDatabase(String deployment)throws Exception {
        String shipped;
        Path repo=Path.of(System.getProperty("user.dir")).toAbsolutePath();
        if(repo.getFileName().toString().equals("server"))repo=repo.getParent();
        if(deployment.equals("docker")){
            var match=java.util.regex.Pattern.compile("SPRING_DATASOURCE_URL=([^\\s]+)").matcher(Files.readString(repo.resolve("Dockerfile")));
            assertThat(match.find()).isTrue();shipped=match.group(1);
        }else{
            var yaml=new YamlPropertiesFactoryBean();yaml.setResources(deployment.equals("java")?new ClassPathResource("application.yml"):new FileSystemResource(repo.resolve("deploy/k8s/configmap.yaml")));
            shipped=Objects.requireNonNull(yaml.getObject()).getProperty(deployment.equals("java")?"spring.datasource.url":"data.SPRING_DATASOURCE_URL");
        }
        String suffix=shipped.contains(";")?shipped.substring(shipped.indexOf(';')):"";
        try(var c=DriverManager.getConnection(file("default-"+deployment)+suffix,"sa","")){
            assertThat(active(c)).as("actual shipped %s connection",deployment).isZero();
        }
    }

    // The schema probe runs before real schema.sql / application runners / background scheduling.
    @ParameterizedTest @ValueSource(strings={"missing","explicit","escaped","reopened","escaped-delay"})
    void normalizesOverridesBeforeSchemaAndAllLaterPhysicalConnections(String scenario)throws Exception {
        String url=file(scenario);
        if(scenario.equals("escaped")){
            url+=";IGNORE_UNKNOWN_SETTINGS=TRUE;DURABILITY_TEST_VALUE=left\\;right";
            // Prove this escaped option is a supported input before exercising the guard.
            try(var original=DriverManager.getConnection(url,"sa","")){assertThat(original.isValid(1)).isTrue();}
        }
        if(scenario.equals("reopened"))try(var c=DriverManager.getConnection(url+";WRITE_DELAY=500","sa","");var s=c.createStatement()){s.execute("CREATE TABLE old_database(id INT)");}
        if(scenario.equals("escaped-delay")){
            url+=";W\\RITE\\_DELAY=500";
            try(var original=DriverManager.getConnection(url,"sa","")){assertThat(active(original)).isEqualTo(500);}
        }
        url+=(scenario.equals("explicit")?";write_delay=500":"")+";LOCK_TIMEOUT=1234;MODE=LEGACY";
        try(var context=start(url,true,null)){
            var pool=(HikariDataSource)context.getBean(DataSource.class);
            if(scenario.equals("escaped"))assertThat(pool.getJdbcUrl()).contains(";DURABILITY_TEST_VALUE=left\\;right");
            Object first;
            try(var one=pool.getConnection();var two=pool.getConnection()){
                assertSafe(one);assertSafe(two);first=one.unwrap(org.h2.jdbc.JdbcConnection.class);
                try(var s=two.createStatement();var rows=s.executeQuery("CALL LOCK_TIMEOUT()")){rows.next();assertThat(rows.getInt(1)).isEqualTo(1234);}
            }
            pool.getHikariPoolMXBean().softEvictConnections();
            try(var later=pool.getConnection()){
                assertThat(later.unwrap(org.h2.jdbc.JdbcConnection.class)).isNotSameAs(first);assertSafe(later);
            }
        }
    }

    @Test void persistentTcpUsesTheSameBeforeSchemaAndPhysicalConnectionPolicy()throws Exception {
        var tcp=org.h2.tools.Server.createTcpServer("-tcpPort","0","-ifNotExists","-tcpDaemon").start();
        try{
            String url="jdbc:h2:tcp://127.0.0.1:"+tcp.getPort()+"/"+root.resolve("tcp").toString().replace('\\','/');
            try(var context=start(url,true,null);var c=context.getBean(DataSource.class).getConnection()){
                // Alias executes on the real server SessionLocal, not a client URL/first SQL row.
                try(var s=c.createStatement();var r=s.executeQuery("CALL METADATA_DURABILITY_ASSERT()")){r.next();assertThat(r.getInt(1)).isZero();}
                assertAllRowsZero(c);
            }
        }finally{tcp.stop();}
    }

    @Test void inMemoryDatabaseKeepsItsExistingConnectionInitialization()throws Exception {
        try(var context=start("jdbc:h2:mem:durability-"+UUID.randomUUID(),false,null,"--spring.datasource.hikari.connection-init-sql=SET LOCK_TIMEOUT 1234","--spring.datasource.hikari.connection-test-query=SELECT 1");var c=context.getBean(DataSource.class).getConnection();var s=c.createStatement();var r=s.executeQuery("CALL LOCK_TIMEOUT()")){
            r.next();assertThat(r.getInt(1)).isEqualTo(1234);
            assertThat(context.getBean(HikariDataSource.class).getConnectionTestQuery()).isEqualTo("SELECT 1");
        }
    }

    // Raw-key matching misses H2's general backslash decoding, not only escaped semicolons.
    @ParameterizedTest @ValueSource(strings={"I\\NIT","\\IN\\IT"})
    void rejectsSemanticallyEscapedInitBeforeApplicationUse(String key)throws Exception {
        String url=file("decoded-init")+";WRITE_DELAY=0;"+key+"=SET WRITE_DELAY 500";
        try(var original=DriverManager.getConnection(url,"sa","")){
            assertThat(active(original)).as("valid input actually executes decoded INIT").isEqualTo(500);
        }
        assertThatThrownBy(()->{try(var ignored=start(url,false,null)) {}}).hasStackTraceContaining("metadata durability");
    }

    @Test void keepsTrailingBackslashMeaningAndAnEffectiveZeroDelayPhysicalUrl()throws Exception {
        String url=file("trailing-option")+";IGNORE_UNKNOWN_SETTINGS=TRUE;DURABILITY_TEST_VALUE=left\\";
        try(var original=DriverManager.getConnection(url,"sa","")){assertThat(original.isValid(1)).isTrue();}
        assertThat(Arrays.asList(org.h2.util.StringUtils.arraySplit(url.substring(url.indexOf(';')+1),';',false)))
            .contains("DURABILITY_TEST_VALUE=left\\");
        try(var context=start(url,true,null)){
            String normalized=context.getBean(HikariDataSource.class).getJdbcUrl();
            // A fresh database, no Hikari init SQL: the physical URL must itself apply zero.
            String options=normalized.substring(normalized.indexOf(';'));
            try(var physical=DriverManager.getConnection(file("fresh-physical")+options,"sa","")){
                assertThat(active(physical)).as("normalized physical URL on a fresh DB").isZero();
            }
            assertThat(Arrays.asList(org.h2.util.StringUtils.arraySplit(options.substring(1),';',false)))
                .contains("DURABILITY_TEST_VALUE=left\\","WRITE_DELAY=0");
        }
    }

    @ParameterizedTest @ValueSource(strings={"SET WRITE_DELAY 500","SELECT 1"})
    void rejectsCustomPersistentValidationSql(String query){
        assertThatThrownBy(()->{try(var ignored=start(file("validation-sql"),false,null,"--spring.datasource.hikari.connection-test-query="+query)) {}})
            .hasStackTraceContaining("metadata durability").hasStackTraceContaining("connection-test-query");
    }

    @Test void privateAcceptanceTcpHelperNeverReintroducesDelayedWrites()throws Exception {
        Path repo=Path.of(System.getProperty("user.dir")).toAbsolutePath();
        if(repo.getFileName().toString().equals("server"))repo=repo.getParent();
        int port;try(var socket=new java.net.ServerSocket(0)){port=socket.getLocalPort();}
        Path ready=root.resolve("helper-ready.txt");
        String javaExecutable=Path.of(System.getProperty("java.home"),"bin",System.getProperty("os.name").startsWith("Windows")?"java.exe":"java").toString();
        String h2=Path.of(org.h2.Driver.class.getProtectionDomain().getCodeSource().getLocation().toURI()).toString();
        var process=new ProcessBuilder(javaExecutable,"--class-path",h2,repo.resolve("apps/runner-agent/tests/helpers/F7dDatabase.java").toString(),root.resolve("helper").toString(),Integer.toString(port),ready.toString())
            .redirectErrorStream(true).redirectOutput(root.resolve("helper.log").toFile()).start();
        try {
            long deadline=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(10);
            while(!Files.exists(ready)&&process.isAlive()&&System.nanoTime()<deadline)process.waitFor(10,java.util.concurrent.TimeUnit.MILLISECONDS);
            assertThat(Files.exists(ready)).as(Files.readString(root.resolve("helper.log"))).isTrue();
            var lines=Files.readAllLines(ready);
            var request=java.net.http.HttpRequest.newBuilder(java.net.URI.create(lines.get(1)+"/sql")).POST(java.net.http.HttpRequest.BodyPublishers.ofString("SELECT SETTING_VALUE FROM INFORMATION_SCHEMA.SETTINGS WHERE SETTING_NAME='WRITE_DELAY'")).build();
            var response=java.net.http.HttpClient.newHttpClient().send(request,java.net.http.HttpResponse.BodyHandlers.ofString());
            assertThat(response.statusCode()).isEqualTo(200);
            assertThat(response.body().lines().toList()).isNotEmpty().allMatch("0"::equals);
        } finally {
            process.destroy();if(!process.waitFor(5,java.util.concurrent.TimeUnit.SECONDS)){process.destroyForcibly();assertThat(process.waitFor(5,java.util.concurrent.TimeUnit.SECONDS)).isTrue();}
            assertThat(process.isAlive()).isFalse();
        }
    }

    @ParameterizedTest @ValueSource(strings={"pool-init","url-init","properties-init"})
    void rejectsInitializationThatCanResetGlobalDurability(String scenario){
        String url=file("unsafe-"+scenario);
        String[] options=scenario.equals("pool-init")?new String[]{"--spring.datasource.hikari.connection-init-sql=SET WRITE_DELAY 500"}:scenario.equals("properties-init")?new String[]{"--spring.datasource.hikari.data-source-properties.INIT=SET WRITE_DELAY 500"}:new String[0];
        if(scenario.equals("url-init"))url+=";INIT=SET WRITE_DELAY 500";
        String selected=url;
        assertThatThrownBy(()->{try(var ignored=start(selected,false,null,options)) {}}).hasStackTraceContaining("metadata durability");
    }

    @Test void rejectsUnconfigurablePersistentDatasource(){
        assertThatThrownBy(()->{try(var ignored=start(file("custom"),false,CustomDataSource.class)) {}}).hasStackTraceContaining("metadata durability");
    }

    @Test void rejectsAlreadyStartedPersistentPool(){
        assertThatThrownBy(()->{try(var ignored=start(file("started"),false,StartedPool.class)) {}}).hasStackTraceContaining("metadata durability");
        assertThat(customPools).allMatch(HikariDataSource::isClosed);
    }

    @ParameterizedTest @ValueSource(strings={"data-source","class","class-only","data-source-decoy-mem"})
    void rejectsPhysicalSourcesThatBypassTheConfiguredJdbcUrl(String scenario){
        assertThatThrownBy(()->{try(var ignored=start(file("alternate-"+scenario),false,AlternatePool.class,"--durability-test-source="+scenario)) {}}).hasStackTraceContaining("metadata durability");
        assertThat(customPools).allMatch(HikariDataSource::isClosed);
    }

    private String file(String name){return "jdbc:h2:file:"+root.resolve(name).toString().replace('\\','/').replace(";","\\;");}
    private ConfigurableApplicationContext start(String url,boolean probe,Class<?> additional,String... extra){
        var args=new ArrayList<>(List.of("--spring.datasource.url="+url,"--spring.datasource.hikari.minimum-idle=0","--spring.datasource.hikari.maximum-pool-size=2","--apicc.server.data-dir="+root.resolve("data"),"--apicc.server.admin-username=durability-admin","--apicc.server.admin-password=synthetic-password8","--logging.level.root=WARN","--spring.main.banner-mode=off"));
        if(probe)args.add("--spring.sql.init.schema-locations=classpath:metadata-durability-before-schema.sql,classpath:schema.sql");
        args.addAll(List.of(extra));
        var builder=new SpringApplicationBuilder(ApiccServerApplication.class).web(WebApplicationType.NONE);
        if(additional!=null)builder.sources(additional);
        return builder.run(args.toArray(String[]::new));
    }
    private static int active(Connection c)throws Exception{return ((org.h2.engine.SessionLocal)c.unwrap(org.h2.jdbc.JdbcConnection.class).getSession()).getDatabase().getWriteDelay();}
    private static void assertSafe(Connection c)throws Exception{assertThat(active(c)).isZero();assertAllRowsZero(c);}
    private static void assertAllRowsZero(Connection c)throws Exception{
        var values=new ArrayList<Integer>();try(var s=c.createStatement();var r=s.executeQuery("SELECT SETTING_VALUE FROM INFORMATION_SCHEMA.SETTINGS WHERE SETTING_NAME='WRITE_DELAY'")){while(r.next())values.add(r.getInt(1));}
        assertThat(values).isNotEmpty().allMatch(value->value==0);
    }
    public static int beforeSchema(Connection c)throws Exception{
        int value=active(c);if(value!=0)throw new SQLException("metadata durability before schema expected active0 but got "+value);
        assertAllRowsZero(c);return value;
    }
    @TestConfiguration(proxyBeanMethods=false) static class CustomDataSource {
        @Bean DataSource dataSource(Environment environment){return new org.springframework.jdbc.datasource.DriverManagerDataSource(environment.getRequiredProperty("spring.datasource.url"),"sa","");}
    }
    @TestConfiguration(proxyBeanMethods=false) static class StartedPool {
        @Bean DataSource dataSource(Environment environment){
            var config=new HikariConfig();config.setJdbcUrl(environment.getRequiredProperty("spring.datasource.url"));config.setUsername("sa");config.setPassword("");config.setMaximumPoolSize(1);
            var source=new HikariDataSource(config);customPools.add(source);return source;
        }
    }
    @TestConfiguration(proxyBeanMethods=false) static class AlternatePool {
        @Bean DataSource dataSource(Environment environment){
            var pool=new HikariDataSource();
            String scenario=environment.getRequiredProperty("durability-test-source"),url=environment.getRequiredProperty("spring.datasource.url");
            if(!scenario.equals("class-only"))pool.setJdbcUrl(scenario.equals("data-source-decoy-mem")?"jdbc:h2:mem:ignored-decoy":url);
            if(scenario.startsWith("data-source"))pool.setDataSource(new org.springframework.jdbc.datasource.DriverManagerDataSource(url+";WRITE_DELAY=500","sa",""));
            else {pool.setDataSourceClassName("org.h2.jdbcx.JdbcDataSource");pool.addDataSourceProperty("URL",url+";WRITE_DELAY=500");pool.setUsername("sa");pool.setPassword("");}
            pool.setMaximumPoolSize(1);customPools.add(pool);return pool;
        }
    }
}
