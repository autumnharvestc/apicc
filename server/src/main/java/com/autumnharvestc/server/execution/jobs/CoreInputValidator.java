package com.autumnharvestc.server.execution.jobs;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.networknt.schema.*;
import org.springframework.stereotype.Component;

import static com.autumnharvestc.server.execution.jobs.JobService.bad;

/** Compiles only checked-in, Core-generated HTTP JSON boundaries; never user schemas/URLs. */
@Component
public class CoreInputValidator {
    private final JsonSchema target;
    private final JsonSchema runConfig;
    private final JsonSchema stressBinding;

    public CoreInputValidator(ObjectMapper json) {
        try (var stream = CoreInputValidator.class.getResourceAsStream("/execution-input-boundary.json")) {
            if (stream == null) throw new IllegalStateException("Missing generated Core input boundary");
            var document = json.readTree(stream);
            requireLocalReferences(document);
            var factory = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012);
            var config = SchemaValidatorsConfig.builder().formatAssertionsEnabled(true).build();
            target = factory.getSchema(SchemaLocation.of("urn:apicc:execution:target"), document.get("target"), config);
            runConfig = factory.getSchema(SchemaLocation.of("urn:apicc:execution:run-config"), document.get("runConfig"), config);
            stressBinding = factory.getSchema(SchemaLocation.of("urn:apicc:execution:stress-binding"), document.get("stressBinding"), config);
        } catch (Exception e) {
            throw new IllegalStateException("Cannot load the local generated Core input boundary", e);
        }
    }

    public void requireStressBinding(JsonNode binding) {
        requireFiniteJson(binding);
        if(binding==null||!stressBinding.validate(binding).isEmpty())bad("stressBinding 不符合 Core 公开编译声明结构");
    }

    public void requireValid(JsonNode targetInput, JsonNode runInput) {
        requireFiniteJson(targetInput);
        requireFiniteJson(runInput);
        if (targetInput == null || !target.validate(targetInput).isEmpty()) bad("target 不符合 Core 公开输入结构");
        if (runInput == null || !runConfig.validate(runInput).isEmpty()) bad("runConfig 不符合 Core 公开运行设置结构");
    }

    private static void requireLocalReferences(JsonNode node) {
        if (node.isObject()) {
            for (String key : new String[]{"$ref", "$dynamicRef", "$recursiveRef"}) {
                if (node.has(key) && (!node.get(key).isTextual() || !node.get(key).asText().startsWith("#"))) {
                    throw new IllegalStateException("Generated Core boundary contains a nonlocal reference");
                }
            }
        }
        if (node.isContainerNode()) node.forEach(CoreInputValidator::requireLocalReferences);
    }

    private static void requireFiniteJson(JsonNode node) {
        if (node == null) return;
        if (node.isNumber() && !Double.isFinite(node.doubleValue())) bad("运行输入只能包含有限 JSON 数值");
        if (node.isContainerNode()) node.forEach(CoreInputValidator::requireFiniteJson);
    }
}
