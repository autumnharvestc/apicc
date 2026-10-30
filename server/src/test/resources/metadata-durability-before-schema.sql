CREATE ALIAS IF NOT EXISTS METADATA_DURABILITY_ASSERT FOR 'com.autumnharvestc.server.store.MetadataDurabilityTest.beforeSchema';
CALL METADATA_DURABILITY_ASSERT();
