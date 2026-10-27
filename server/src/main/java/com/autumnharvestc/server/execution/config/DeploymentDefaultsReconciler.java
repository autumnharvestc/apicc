package com.autumnharvestc.server.execution.config;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/** Reconcile after schema initialization and before the server is marked ready. */
@Component
@Order(3)
public class DeploymentDefaultsReconciler implements ApplicationRunner {
    private final ExecutionConfigService configs;
    public DeploymentDefaultsReconciler(ExecutionConfigService configs) { this.configs = configs; }
    @Override public void run(ApplicationArguments args) { configs.reconcileDeploymentDefaults(); }
}
