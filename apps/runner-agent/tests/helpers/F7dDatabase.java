import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.sql.*;
import java.util.*;
import java.util.concurrent.*;
import org.h2.api.Trigger;

/** Private acceptance process only: real H2 clock/transactions, no product hook. */
public final class F7dDatabase {
    static volatile boolean armed;
    static volatile CountDownLatch release = new CountDownLatch(0);
    static volatile String observed = "none";
    public static final class AfterJobInsert implements Trigger {
        public void fire(Connection connection, Object[] oldRow, Object[] newRow) throws SQLException {
            if (!armed) return;
            armed = false;
            try (var statement=connection.createStatement(); var rows=statement.executeQuery("SELECT COUNT(*) FROM execution_jobs")) {
                rows.next(); observed = "inserted id="+newRow[0]+" transactionVisibleJobs="+rows.getLong(1);
            }
            try { if (!release.await(60, TimeUnit.SECONDS)) throw new SQLException("Private after-insert barrier deadline"); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new SQLException(interrupted); }
        }
    }
    public static void main(String[] args) throws Exception {
        String database=Path.of(args[0]).toAbsolutePath().toString().replace('\\','/');
        var tcp=org.h2.tools.Server.createTcpServer("-tcpPort",args[1],"-ifNotExists","-tcpDaemon").start();
        String url="jdbc:h2:tcp://127.0.0.1:"+args[1]+"/"+database+";WRITE_DELAY=0";
        try(var ignored=DriverManager.getConnection(url,"sa","")){}
        var http=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        http.setExecutor(Executors.newCachedThreadPool());
        http.createContext("/",exchange->{
            String action=exchange.getRequestURI().getPath(), output=""; int status=200;
            try {
                if(action.equals("/arm")) { observed="armed"; release=new CountDownLatch(1); armed=true; output=observed; }
                else if(action.equals("/barrier")) output=observed;
                else if(action.equals("/release")) { release.countDown(); output="released"; }
                else if(action.equals("/sql")) {
                    String sql=new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8);
                    try(var connection=DriverManager.getConnection(url,"sa","");var statement=connection.createStatement()) {
                        if(statement.execute(sql)) try(var rows=statement.getResultSet()) {
                            var meta=rows.getMetaData();var lines=new ArrayList<String>();
                            while(rows.next()){var values=new ArrayList<String>();for(int i=1;i<=meta.getColumnCount();i++)values.add(String.valueOf(rows.getObject(i)));lines.add(String.join("\t",values));}
                            output=String.join("\n",lines);
                        } else output="updated="+statement.getUpdateCount();
                    }
                } else {status=404;output="unknown private operation";}
            } catch(Exception failure){status=500;output=failure.toString();}
            byte[] bytes=output.getBytes(StandardCharsets.UTF_8);exchange.sendResponseHeaders(status,bytes.length);exchange.getResponseBody().write(bytes);exchange.close();
        });
        http.start();
        String readyGate=System.getenv("APICC_F7D_READY_GATE");
        if(readyGate!=null){
            Files.writeString(Path.of(args[2]),"");
            Files.writeString(Path.of(readyGate+".entered"),"partial ready created");
            long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(10);
            while(!Files.exists(Path.of(readyGate))&&System.nanoTime()<deadline)Thread.sleep(5);
            if(!Files.exists(Path.of(readyGate)))throw new IllegalStateException("Private ready probe was not released");
        }
        var readyPath=Path.of(args[2]);
        var temporary=readyPath.resolveSibling(readyPath.getFileName()+".tmp");
        Files.writeString(temporary,url+"\nhttp://127.0.0.1:"+http.getAddress().getPort()+"\n");
        Files.move(temporary,readyPath,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
        Runtime.getRuntime().addShutdownHook(new Thread(()->{release.countDown();http.stop(0);tcp.stop();}));
        new CountDownLatch(1).await();
    }
}
