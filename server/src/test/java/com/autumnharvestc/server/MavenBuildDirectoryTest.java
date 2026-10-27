package com.autumnharvestc.server;

import java.nio.file.Path;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class MavenBuildDirectoryTest {
    @Test
    void diagnosticDirectoryMatchesTheActualMavenTestOutputRoot() throws Exception {
        String configuredDirectory = System.getProperty("apicc.build.directory");
        assertThat(configuredDirectory)
            .as("Maven must pass its resolved build directory to the test JVM")
            .isNotBlank();

        Path actualTestOutput = Path.of(getClass().getProtectionDomain()
            .getCodeSource().getLocation().toURI());
        assertThat(Path.of(configuredDirectory).toAbsolutePath().normalize())
            .isEqualTo(actualTestOutput.toAbsolutePath().normalize().getParent());
    }
}
