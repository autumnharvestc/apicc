package com.autumnharvestc.server.execution;

import com.autumnharvestc.server.execution.scheduling.ScheduleNetworkValidator;
import com.autumnharvestc.server.core.ApiException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.*;
import java.util.stream.Stream;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.*;
import static org.assertj.core.api.Assertions.*;

class ScheduleNetworkBoundaryTest {
    static Stream<Arguments> origins()throws Exception{
        try(var input=ScheduleNetworkBoundaryTest.class.getResourceAsStream("/scheduling/origins.json")){
            var rows=new ObjectMapper().readTree(input);var cases=new ArrayList<Arguments>();
            for(var row:rows)for(String kind:List.of("proxy","tls"))cases.add(Arguments.of(row.path("value").asText(),kind,row.path(kind).asBoolean()));
            return cases.stream();
        }
    }
    @ParameterizedTest(name="{1} {0} accepted={2}") @MethodSource("origins")
    void matchesTheSharedCoreCanonicalOriginBoundary(String origin,String kind,boolean accepted){
        var profile=kind.equals("proxy")?Map.of("id","p","name","Proxy","kind","proxy","proxyUrl",origin,"targetTlsBindings",List.of()):Map.of("id","p","name","TLS","kind","direct","targetTlsBindings",List.of(Map.of("origin",origin,"tls",Map.of())));
        var network=Map.of("revision","1","configuration",Map.of("formatVersion",1,"profiles",List.of(profile),"projectSelection",Map.of("kind","profile","profileId","p"),"environmentSelections",List.of()));
        var encoded=new ObjectMapper().valueToTree(network);var validator=new ScheduleNetworkValidator();
        if(accepted)assertThatCode(()->validator.validate(encoded,Map.of())).doesNotThrowAnyException();
        else assertThatThrownBy(()->validator.validate(encoded,Map.of())).isInstanceOfSatisfying(ApiException.class,e->assertThat(e.getCode()).isEqualTo("validation_failed"));
    }
}
