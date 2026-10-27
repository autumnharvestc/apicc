package com.autumnharvestc.server.execution.materials;

import com.autumnharvestc.server.auth.AuthFilter;
import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.execution.agent.AgentPrincipal;
import com.autumnharvestc.server.execution.ExecutionDtos.*;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1")
public class ExecutionMaterialsController {
    private final ProjectCredentialService credentials;private final AttachmentService attachments;private final ExecutionMaterialsService materials;
    public ExecutionMaterialsController(ProjectCredentialService credentials,AttachmentService attachments,ExecutionMaterialsService materials){this.credentials=credentials;this.attachments=attachments;this.materials=materials;}
    @ModelAttribute public void noCache(jakarta.servlet.http.HttpServletResponse response){response.setHeader("Cache-Control","no-store");}
    @PutMapping("/workspaces/{ws}/projects/{project}/credentials/{ref}")
    public CredentialMetadata credential(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,@PathVariable String ws,@PathVariable String project,@PathVariable String ref,@RequestBody JsonNode input){return credentials.put(caller,ws,project,ref,com.autumnharvestc.server.execution.ExecutionDtos.decode(input,CredentialWrite.class));}
    @GetMapping("/workspaces/{ws}/projects/{project}/credentials")
    public java.util.List<CredentialMetadata> credentials(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,@PathVariable String ws,@PathVariable String project){return credentials.list(caller,ws,project);}
    @DeleteMapping("/workspaces/{ws}/projects/{project}/credentials/{ref}") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void removeCredential(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,@PathVariable String ws,@PathVariable String project,@PathVariable String ref,@RequestParam String expectedVersion){credentials.remove(caller,ws,project,ref,expectedVersion);}
    @PostMapping("/execution-snapshots/{snapshot}/local-materials")
    public ProjectRunMaterials local(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,@PathVariable String snapshot,@RequestBody JsonNode input){return materials.local(caller,snapshot,com.autumnharvestc.server.execution.ExecutionDtos.decode(input,MaterialSelection.class));}
    @PostMapping("/runner/jobs/{job}/materials")
    public ProjectRunMaterials agent(@RequestAttribute(AgentPrincipal.ATTRIBUTE) AgentPrincipal agent,@PathVariable String job,@RequestBody JsonNode input){return materials.agent(agent,job,com.autumnharvestc.server.execution.ExecutionDtos.decode(input,AgentMaterialRequest.class));}
    @PostMapping("/workspaces/{ws}/projects/{project}/attachments") @ResponseStatus(HttpStatus.CREATED)
    public AttachmentMetadata attachment(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,@PathVariable String ws,@PathVariable String project,@RequestBody JsonNode input){return attachments.put(caller,ws,project,com.autumnharvestc.server.execution.ExecutionDtos.decode(input,AttachmentWrite.class));}
    @GetMapping("/workspaces/{ws}/projects/{project}/attachments")
    public java.util.List<AttachmentMetadata> attachments(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,@PathVariable String ws,@PathVariable String project){return attachments.list(caller,ws,project);}
    @DeleteMapping("/workspaces/{ws}/projects/{project}/attachments/{ref}") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void removeAttachment(@RequestAttribute(AuthFilter.ATTR_USER) UserAccount caller,@PathVariable String ws,@PathVariable String project,@PathVariable String ref,@RequestParam String expectedVersion){attachments.remove(caller,ws,project,ref,expectedVersion);}
}
