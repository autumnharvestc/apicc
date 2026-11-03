package com.autumnharvestc.server.collaboration.artifacts;

import java.time.Instant;
import org.springframework.stereotype.Component;

/** Publication-local clock; does not replace execution or database clocks. */
@Component
public class CollaborationTime { public Instant now(){return Instant.now();} }
