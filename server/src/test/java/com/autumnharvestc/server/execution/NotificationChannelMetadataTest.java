package com.autumnharvestc.server.execution;

import java.util.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.test.context.TestPropertySource;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@TestPropertySource(properties="spring.datasource.url=jdbc:h2:mem:apicc-t7-channel-metadata;DB_CLOSE_DELAY=-1")
class NotificationChannelMetadataTest extends ScheduleFixture {
    @org.springframework.test.context.bean.override.mockito.MockitoBean com.autumnharvestc.server.execution.notifications.NotificationTimer notificationTimer;
    com.fasterxml.jackson.databind.JsonNode metadata(boolean enabled,boolean readable,boolean supported)throws Exception {
        var f=fixture();String url="/api/v1/workspaces/"+f.ws()+"/notification-channels";
        var created=body(member(f,post(url),Map.of("expectedVersion","0","name","材料状态合成渠道","url","https://hook.example.test/private?key=synthetic-metadata-url","hmacSecret","synthetic-metadata-hmac","enabled",true)).andExpect(status().isCreated()));
        String id=created.path("id").asText();if(!readable)jdbc.update("UPDATE execution_notification_channels SET version=version+1 WHERE id=?",Long.valueOf(id));
        jdbc.update("UPDATE execution_notification_channels SET enabled=?,origin=? WHERE id=?",enabled,supported?"https://hook.example.test":"https://xn--bcher-kva.test",Long.valueOf(id));
        var page=body(member(f,get(url),Map.of()).andExpect(status().isOk()));var row=java.util.stream.StreamSupport.stream(page.path("items").spliterator(),false).filter(item->item.path("id").asText().equals(id)).findFirst().orElseThrow();
        if(Boolean.getBoolean("apicc.captureSchedulingAdmin")){var dir=java.nio.file.Path.of("src/test/resources/scheduling");java.nio.file.Files.createDirectories(dir);java.nio.file.Files.writeString(dir.resolve("t7-channel-"+enabled+"-"+readable+"-"+supported+".json"),json.writerWithDefaultPrettyPrinter().writeValueAsString(row)+"\n",java.nio.charset.StandardCharsets.UTF_8);}
        assertThat(row.toString()).doesNotContain("synthetic-metadata-url","synthetic-metadata-hmac","private?","ciphertext");return row;
    }
    @ParameterizedTest @CsvSource({"true,true,true","true,true,false","true,false,true","true,false,false","false,true,true","false,true,false","false,false,true","false,false,false"})
    void projectsIndependentMaterialReadabilityFromActualGet(boolean enabled,boolean readable,boolean supported)throws Exception {
        var row=metadata(enabled,readable,supported);assertThat(row.path("keyState").asText()).isEqualTo(!enabled?"not-checked":readable?"available":"unavailable");
    }
    @ParameterizedTest @CsvSource({"true,true,true","true,true,false","true,false,true","true,false,false","false,true,true","false,true,false","false,false,true","false,false,false"})
    void projectsIndependentSafeReasonsFromActualGet(boolean enabled,boolean readable,boolean supported)throws Exception {
        var row=metadata(enabled,readable,supported);assertThat(row.path("reasonCodes").isArray()).isTrue();
        var expected=new ArrayList<String>();if(enabled&&!readable)expected.add("channel-key-unavailable");if(!supported)expected.add("unsupported-origin");
        assertThat(json.convertValue(row.path("reasonCodes"),new com.fasterxml.jackson.core.type.TypeReference<List<String>>(){})).containsExactlyInAnyOrderElementsOf(expected);
        assertThat(row.path("status").asText()).isEqualTo(!enabled?"disabled":readable&&supported?"available":"unavailable");
    }
}
