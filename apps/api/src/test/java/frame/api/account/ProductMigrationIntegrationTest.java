package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.FlywayException;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Real migration checks only in a loopback verification DB and a schema owned by this test. No Flyway clean/repair. */
@EnabledIfEnvironmentVariable(named = "FRAME_PRODUCT_TEST_CONFIG", matches = ".+")
class ProductMigrationIntegrationTest {
    @TempDir Path temporary;

    @Test void emptySchemaMigratesAndRepeatedStartupDoesNotReapplySql() throws Exception {
        try (Database database = Database.create()) {
            Flyway flyway = database.configuration().load();
            assertEquals(11, flyway.migrate().migrationsExecuted);
            assertTrue(flyway.validateWithResult().validationSuccessful);
            assertEquals(11, flyway.info().applied().length);
            assertEquals(0, flyway.migrate().migrationsExecuted);
            assertEquals(11, database.number("SELECT count(*) FROM " + database.table("flyway_schema_history") + " WHERE success"));
            assertEquals(19, database.number("SELECT count(*) FROM information_schema.tables WHERE table_schema='" + database.schema + "' AND table_name IN ('product_accounts','product_channels','product_follows','product_broadcast_schedules','product_watch_history','product_channel_handles','product_channel_reports','product_notification_events','product_notifications','product_chat_settings','product_chat_blocks','product_polls','product_poll_options','product_poll_votes','product_questions','product_rewards','product_point_wallets','product_redemptions','product_point_ledger')"));
        }
    }

    @Test void latestPreservesVersionOneAccountsChannelsFollowsAndUnknownConsent() throws Exception {
        try (Database database = Database.create()) {
            assertEquals(1, database.configuration().target("1").load().migrate().migrationsExecuted);
            UUID owner = UUID.randomUUID(), viewer = UUID.randomUUID(), channel = UUID.randomUUID();
            try (var insert = database.connection.prepareStatement("INSERT INTO " + database.table("product_accounts") + " (id,email,password_hash,display_name) VALUES (?,?,?,?),(?,?,?,?)")) {
                insert.setObject(1, owner); insert.setString(2, "owner@example.invalid"); insert.setString(3, "verification-hash"); insert.setString(4, "이전 채널");
                insert.setObject(5, viewer); insert.setString(6, "viewer@example.invalid"); insert.setString(7, "verification-hash"); insert.setString(8, "이전 시청자"); insert.executeUpdate();
            }
            try (var insert = database.connection.prepareStatement("INSERT INTO " + database.table("product_channels") + " (id,owner_id,handle,display_name,description,banner_preset) VALUES (?,?,?,?,?,?)")) {
                insert.setObject(1, channel); insert.setObject(2, owner); insert.setString(3, "previous-channel"); insert.setString(4, "이전 채널"); insert.setString(5, "업그레이드 전에 저장한 소개"); insert.setString(6, "forest"); insert.executeUpdate();
            }
            try (var insert = database.connection.prepareStatement("INSERT INTO " + database.table("product_follows") + " (user_id,channel_id,notifications_on) VALUES (?,?,true)")) {
                insert.setObject(1, viewer); insert.setObject(2, channel); insert.executeUpdate();
            }
            Flyway latest = database.configuration().load();
            assertEquals(10, latest.migrate().migrationsExecuted);
            assertTrue(latest.validateWithResult().validationSuccessful);
            assertEquals(2, database.number("SELECT count(*) FROM " + database.table("product_accounts") + " WHERE terms_version IS NULL AND privacy_version IS NULL AND consented_at IS NULL"));
            assertEquals(1, database.number("SELECT count(*) FROM " + database.table("product_channels") + " WHERE handle='previous-channel' AND description='업그레이드 전에 저장한 소개' AND banner_preset='forest'"));
            assertEquals(1, database.number("SELECT count(*) FROM " + database.table("product_channel_handles") + " WHERE handle='previous-channel' AND channel_id='" + channel + "'"));
            assertEquals(1, database.number("SELECT count(*) FROM " + database.table("product_channels") + " WHERE country_code IS NULL AND links='[]'::jsonb"));
            assertEquals(1, database.number("SELECT count(*) FROM " + database.table("product_follows") + " WHERE notifications_on"));
            try (var statement = database.connection.createStatement()) {
                assertThrows(SQLException.class, () -> statement.executeUpdate("UPDATE " + database.table("product_accounts") + " SET terms_version='2026-11-11'"));
            }
            assertEquals(2, database.number("SELECT count(*) FROM " + database.table("product_accounts") + " WHERE terms_version IS NULL AND privacy_version IS NULL AND consented_at IS NULL"));
        }
    }

    @Test void historyMigrationPreservesExistingSchedulesAndUsesPrivateForeignKeys() throws Exception {
        try (Database database = Database.create()) {
            assertEquals(3, database.configuration().target("3").load().migrate().migrationsExecuted);
            UUID owner = UUID.randomUUID(), channel = UUID.randomUUID(), schedule = UUID.randomUUID(), history = UUID.randomUUID();
            try (var statement = database.connection.createStatement()) {
                statement.executeUpdate("INSERT INTO " + database.table("product_accounts") + "(id,email,password_hash,display_name) VALUES('" + owner + "','migration@example.invalid','hash','보존 회원')");
                statement.executeUpdate("INSERT INTO " + database.table("product_channels") + "(id,owner_id,handle,display_name) VALUES('" + channel + "','" + owner + "','old-schedule-owner','기존 채널')");
                statement.executeUpdate("INSERT INTO " + database.table("product_broadcast_schedules") + "(id,channel_id,title,starts_at) VALUES('" + schedule + "','" + channel + "','기존 예약 보존',current_timestamp + interval '1 day')");
            }
            Flyway latest = database.configuration().load();
            assertEquals(8, latest.migrate().migrationsExecuted); assertTrue(latest.validateWithResult().validationSuccessful);
            assertEquals(1, database.number("SELECT count(*) FROM " + database.table("product_broadcast_schedules") + " WHERE id='" + schedule + "' AND title='기존 예약 보존'"));
            try (var statement = database.connection.createStatement()) {
                statement.executeUpdate("INSERT INTO " + database.table("product_watch_history") + "(id,user_id,broadcast_id,path,broadcast_instance_id,title,publisher,channel_id,watched_at_ms) VALUES('" + history + "','" + owner + "','" + "a".repeat(32) + "','source','" + UUID.randomUUID() + "','보존 기록','채널','" + channel + "',1794442212345)");
                statement.executeUpdate("DELETE FROM " + database.table("product_channels") + " WHERE id='" + channel + "'");
            }
            assertEquals(1, database.number("SELECT count(*) FROM " + database.table("product_watch_history") + " WHERE id='" + history + "' AND title='보존 기록' AND channel_id IS NULL"));
            try (var statement = database.connection.createStatement()) { statement.executeUpdate("DELETE FROM " + database.table("product_accounts") + " WHERE id='" + owner + "'"); }
            assertEquals(0, database.number("SELECT count(*) FROM " + database.table("product_watch_history")));
        }
    }
    @Test void profileMigrationKeepsExistingChannelDatesRelationsAndPrivateHistory() throws Exception {
        try (Database database = Database.create()) {
            assertEquals(4, database.configuration().target("4").load().migrate().migrationsExecuted);
            UUID owner = UUID.randomUUID(), viewer = UUID.randomUUID(), channel = UUID.randomUUID(), history = UUID.randomUUID();
            try (var statement = database.connection.createStatement()) {
                statement.executeUpdate("INSERT INTO " + database.table("product_accounts") + "(id,email,password_hash,display_name) VALUES('" + owner + "','profile-owner@example.invalid','hash','기존 소유자'),('" + viewer + "','profile-viewer@example.invalid','hash','기존 시청자')");
                statement.executeUpdate("INSERT INTO " + database.table("product_channels") + "(id,owner_id,handle,display_name,description,created_at) VALUES('" + channel + "','" + owner + "','profile-before-v5','기존 채널','기존 소개','2025-01-01T12:34:56.789Z')");
                statement.executeUpdate("INSERT INTO " + database.table("product_follows") + "(user_id,channel_id,notifications_on) VALUES('" + viewer + "','" + channel + "',true)");
                statement.executeUpdate("INSERT INTO " + database.table("product_broadcast_schedules") + "(id,channel_id,title,starts_at) VALUES('" + UUID.randomUUID() + "','" + channel + "','V4 예약',current_timestamp + interval '1 day')");
                statement.executeUpdate("INSERT INTO " + database.table("product_watch_history") + "(id,user_id,broadcast_id,path,broadcast_instance_id,title,publisher,channel_id,watched_at_ms) VALUES('" + history + "','" + viewer + "','" + "a".repeat(32) + "','source','" + UUID.randomUUID() + "','V4 기록','채널','" + channel + "',1794442212345)");
            }
            assertEquals(7, database.configuration().load().migrate().migrationsExecuted);
            assertEquals(1, database.number("SELECT count(*) FROM " + database.table("product_channels") + " WHERE id='" + channel + "' AND created_at='2025-01-01T12:34:56.789Z' AND description='기존 소개' AND country_code IS NULL AND links='[]'::jsonb"));
            assertEquals(1, database.number("SELECT count(*) FROM " + database.table("product_channel_handles") + " WHERE handle='profile-before-v5' AND channel_id='" + channel + "'"));
            assertEquals(1, database.number("SELECT count(*) FROM " + database.table("product_follows") + " WHERE channel_id='" + channel + "' AND notifications_on"));
            assertEquals(1, database.number("SELECT count(*) FROM " + database.table("product_broadcast_schedules") + " WHERE channel_id='" + channel + "' AND title='V4 예약'"));
            assertEquals(1, database.number("SELECT count(*) FROM " + database.table("product_watch_history") + " WHERE id='" + history + "' AND channel_id='" + channel + "' AND title='V4 기록'"));
            try (var statement = database.connection.createStatement()) { statement.executeUpdate("DELETE FROM " + database.table("product_channels") + " WHERE id='" + channel + "'"); }
            assertEquals(1, database.number("SELECT count(*) FROM " + database.table("product_channel_handles") + " WHERE handle='profile-before-v5' AND channel_id IS NULL"));
            assertEquals(1, database.number("SELECT count(*) FROM " + database.table("product_watch_history") + " WHERE id='" + history + "' AND channel_id IS NULL"));
        }
    }
    @Test void reportManagementMigrationPreservesReceiptsAndDoesNotPromoteAnyAccount() throws Exception {
        try (Database database = Database.create()) {
            assertEquals(5, database.configuration().target("5").load().migrate().migrationsExecuted);
            UUID owner = UUID.randomUUID(), reporter = UUID.randomUUID(), channel = UUID.randomUUID(), report = UUID.randomUUID();
            try (var statement = database.connection.createStatement()) {
                statement.executeUpdate("INSERT INTO " + database.table("product_accounts") + "(id,email,password_hash,display_name) VALUES('" + owner + "','old-owner@example.invalid','hash','기존 소유자'),('" + reporter + "','old-reporter@example.invalid','hash','기존 신고자')");
                statement.executeUpdate("INSERT INTO " + database.table("product_channels") + "(id,owner_id,handle,display_name) VALUES('" + channel + "','" + owner + "','before-reports-v6','기존 채널')");
                statement.executeUpdate("INSERT INTO " + database.table("product_channel_reports") + "(id,channel_id,reporter_id,reason,details,created_at) VALUES('" + report + "','" + channel + "','" + reporter + "','spam','원문 유지','2026-11-01T01:02:03.123456Z')");
            }
            assertEquals(6, database.configuration().load().migrate().migrationsExecuted);
            assertEquals(0, database.number("SELECT count(*) FROM " + database.table("product_accounts") + " WHERE is_operator"));
            assertEquals(1, database.number("SELECT count(*) FROM " + database.table("product_channel_reports") + " WHERE id='" + report + "' AND details='원문 유지' AND reason='spam' AND status='received' AND version=0 AND review_note='' AND reviewed_by IS NULL AND updated_at=created_at AND created_at='2026-11-01T01:02:03.123456Z'"));
            try (var statement = database.connection.createStatement()) {
                assertThrows(SQLException.class, () -> statement.executeUpdate("UPDATE " + database.table("product_channel_reports") + " SET status='resolved' WHERE id='" + report + "'"));
                statement.executeUpdate("UPDATE " + database.table("product_channel_reports") + " SET status='reviewing',review_note='검토 중',reviewed_by='" + owner + "' WHERE id='" + report + "'");
                statement.executeUpdate("DELETE FROM " + database.table("product_accounts") + " WHERE id='" + owner + "'");
            }
            // The target owner deletion cascades their channel and reports, without promoting the remaining account.
            assertEquals(0, database.number("SELECT count(*) FROM " + database.table("product_channel_reports")));
            assertEquals(1, database.number("SELECT count(*) FROM " + database.table("product_accounts") + " WHERE NOT is_operator"));
        }
    }
    @Test void notificationsMigrationBaselinesExistingSubscriptionsWithoutInventingPastAlerts() throws Exception {
        try (Database database = Database.create()) {
            assertEquals(6, database.configuration().target("6").load().migrate().migrationsExecuted);
            UUID owner = UUID.randomUUID(), on = UUID.randomUUID(), off = UUID.randomUUID(), channel = UUID.randomUUID();
            try (var statement = database.connection.createStatement()) {
                statement.executeUpdate("INSERT INTO " + database.table("product_accounts") + "(id,email,password_hash,display_name) VALUES('" + owner + "','notification-owner@example.invalid','hash','채널'),('" + on + "','notification-on@example.invalid','hash','알림 켬'),('" + off + "','notification-off@example.invalid','hash','알림 끔')");
                statement.executeUpdate("INSERT INTO " + database.table("product_channels") + "(id,owner_id,handle,display_name,stream_path) VALUES('" + channel + "','" + owner + "','notifications-before-v7','기존 채널','source')");
                statement.executeUpdate("INSERT INTO " + database.table("product_follows") + "(user_id,channel_id,notifications_on,created_at) VALUES('" + on + "','" + channel + "',true,'2025-01-01T00:00:00Z'),('" + off + "','" + channel + "',false,'2025-01-01T00:00:00Z')");
            }
            assertEquals(5, database.configuration().load().migrate().migrationsExecuted);
            assertEquals(1, database.number("SELECT count(*) FROM " + database.table("product_follows") + " WHERE notifications_on AND notifications_enabled_at > current_timestamp - interval '1 minute' AND created_at='2025-01-01T00:00:00Z'"));
            assertEquals(1, database.number("SELECT count(*) FROM " + database.table("product_follows") + " WHERE NOT notifications_on AND notifications_enabled_at IS NULL"));
            assertEquals(1, database.number("SELECT count(*) FROM " + database.table("product_channels") + " WHERE notification_live_after_ms>0 AND stream_path='source'"));
            assertEquals(0, database.number("SELECT count(*) FROM " + database.table("product_notifications")));
            assertEquals(0, database.number("SELECT count(*) FROM " + database.table("product_notification_events")));
            assertEquals(0, database.number("SELECT count(*) FROM " + database.table("product_accounts") + " WHERE is_operator"));
        }
    }
    @Test void chatMigrationKeepsExistingProfileFollowAndNotificationState() throws Exception {
        try(Database database=Database.create()){
            assertEquals(7,database.configuration().target("7").load().migrate().migrationsExecuted);
            UUID owner=UUID.randomUUID(),viewer=UUID.randomUUID(),channel=UUID.randomUUID(),notification=UUID.randomUUID();
            try(var statement=database.connection.createStatement()){
                statement.executeUpdate("INSERT INTO "+database.table("product_accounts")+"(id,email,password_hash,display_name) VALUES('"+owner+"','chat-owner@example.invalid','hash','소유자'),('"+viewer+"','chat-viewer@example.invalid','hash','시청자')");
                statement.executeUpdate("INSERT INTO "+database.table("product_channels")+"(id,owner_id,handle,display_name,description) VALUES('"+channel+"','"+owner+"','chat-before-v8','기존 채널','소개 보존')");
                statement.executeUpdate("INSERT INTO "+database.table("product_follows")+"(user_id,channel_id,notifications_on,notifications_enabled_at) VALUES('"+viewer+"','"+channel+"',true,current_timestamp)");
                statement.executeUpdate("INSERT INTO "+database.table("product_notification_events")+"(event_key,created_at_ms) VALUES('migration-receipt',1794442212345)");
                statement.executeUpdate("INSERT INTO "+database.table("product_notifications")+"(id,recipient_id,event_key,kind,title,body,created_at_ms,read_at_ms,report_id,report_status) VALUES('"+notification+"','"+viewer+"','migration-receipt','report','기존 알림','일반 결과',1794442212345,1794442212346,'"+UUID.randomUUID()+"','resolved')");
            }
            assertEquals(4,database.configuration().load().migrate().migrationsExecuted);
            assertEquals(1,database.number("SELECT count(*) FROM "+database.table("product_channels")+" WHERE id='"+channel+"' AND description='소개 보존'"));
            assertEquals(1,database.number("SELECT count(*) FROM "+database.table("product_follows")+" WHERE user_id='"+viewer+"' AND notifications_on AND notifications_enabled_at IS NOT NULL"));
            assertEquals(1,database.number("SELECT count(*) FROM "+database.table("product_notifications")+" WHERE id='"+notification+"' AND body='일반 결과' AND read_at_ms=1794442212346"));
            assertEquals(1,database.number("SELECT count(*) FROM "+database.table("product_chat_settings")+" WHERE channel_id='"+channel+"' AND version=0 AND updated_at_ms>0 AND NOT slow_mode AND NOT followers_only AND NOT block_links AND banned_words='[]'::jsonb"));
            assertEquals(0,database.number("SELECT count(*) FROM "+database.table("product_chat_blocks")));
        }
    }
    @Test void pollsMigrationPreservesPoliciesAndEnforcesOneOpenSlotAndAccountVotes() throws Exception {
        try(Database database=Database.create()){
            assertEquals(8,database.configuration().target("8").load().migrate().migrationsExecuted);
            UUID owner=UUID.randomUUID(),viewer=UUID.randomUUID(),channel=UUID.randomUUID(),first=UUID.randomUUID(),second=UUID.randomUUID(),one=UUID.randomUUID(),two=UUID.randomUUID();
            try(var statement=database.connection.createStatement()){
                statement.executeUpdate("INSERT INTO "+database.table("product_accounts")+"(id,email,password_hash,display_name) VALUES('"+owner+"','poll-owner@example.invalid','hash','기존 소유자'),('"+viewer+"','poll-viewer@example.invalid','hash','기존 시청자')");
                statement.executeUpdate("INSERT INTO "+database.table("product_channels")+"(id,owner_id,handle,display_name,description) VALUES('"+channel+"','"+owner+"','polls-before-v9','기존 채널','기존 소개')");
                statement.executeUpdate("INSERT INTO "+database.table("product_chat_settings")+"(channel_id,slow_mode,slow_seconds,followers_only,block_links,banned_words,version,updated_at_ms) VALUES('"+channel+"',true,30,true,true,'[\"선행 정책\"]'::jsonb,7,1794442212345)");
            }
            assertEquals(3,database.configuration().load().migrate().migrationsExecuted);
            assertEquals(1,database.number("SELECT count(*) FROM "+database.table("product_channels")+" WHERE id='"+channel+"' AND description='기존 소개'"));
            assertEquals(1,database.number("SELECT count(*) FROM "+database.table("product_chat_settings")+" WHERE channel_id='"+channel+"' AND version=7 AND slow_seconds=30 AND followers_only AND block_links AND banned_words='[\"선행 정책\"]'::jsonb"));
            assertEquals(0,database.number("SELECT count(*) FROM "+database.table("product_polls")));
            try(var statement=database.connection.createStatement()){
                String fields="(id,channel_id,broadcast_id,path,broadcast_instance_id,question,created_at_ms,ends_at_ms)";
                statement.executeUpdate("INSERT INTO "+database.table("product_polls")+fields+" VALUES('"+first+"','"+channel+"','"+"a".repeat(32)+"','source','"+UUID.randomUUID()+"','첫 투표',1794442212345,1794442272345)");
                assertThrows(SQLException.class,()->statement.executeUpdate("INSERT INTO "+database.table("product_polls")+fields+" VALUES('"+second+"','"+channel+"','"+"a".repeat(32)+"','source','"+UUID.randomUUID()+"','다른 열린 투표',1794442212345,1794442272345)"));
                statement.executeUpdate("INSERT INTO "+database.table("product_polls")+"(id,channel_id,broadcast_id,path,broadcast_instance_id,question,created_at_ms,ends_at_ms,closed_at_ms,close_reason) VALUES('"+second+"','"+channel+"','"+"b".repeat(32)+"','source','"+UUID.randomUUID()+"','이전 결과',1794442212345,1794442272345,1794442212346,'manual')");
                statement.executeUpdate("INSERT INTO "+database.table("product_poll_options")+"(id,poll_id,position,text) VALUES('"+one+"','"+first+"',0,'첫 선택'),('"+two+"','"+second+"',0,'다른 투표 선택')");
                assertThrows(SQLException.class,()->statement.executeUpdate("INSERT INTO "+database.table("product_poll_votes")+"(poll_id,user_id,option_id,created_at_ms) VALUES('"+first+"','"+viewer+"','"+two+"',1794442212346)"));
                statement.executeUpdate("INSERT INTO "+database.table("product_poll_votes")+"(poll_id,user_id,option_id,created_at_ms) VALUES('"+first+"','"+viewer+"','"+one+"',1794442212346)");
                assertThrows(SQLException.class,()->statement.executeUpdate("INSERT INTO "+database.table("product_poll_votes")+"(poll_id,user_id,option_id,created_at_ms) VALUES('"+first+"','"+viewer+"','"+one+"',1794442212347)"));
            }
            assertEquals(1,database.number("SELECT count(*) FROM "+database.table("product_poll_votes")));
        }
    }
    @Test void questionsMigrationPreservesPollResultsAndEnforcesPrivateIdempotencyAndOnePin() throws Exception {
        try(Database database=Database.create()){
            assertEquals(9,database.configuration().target("9").load().migrate().migrationsExecuted);
            UUID owner=UUID.randomUUID(),viewer=UUID.randomUUID(),channel=UUID.randomUUID(),poll=UUID.randomUUID(),option=UUID.randomUUID(),first=UUID.randomUUID(),second=UUID.randomUUID(),request=UUID.randomUUID();
            try(var statement=database.connection.createStatement()){
                statement.executeUpdate("INSERT INTO "+database.table("product_accounts")+"(id,email,password_hash,display_name) VALUES('"+owner+"','question-owner@example.invalid','hash','기존 소유자'),('"+viewer+"','question-viewer@example.invalid','hash','기존 시청자')");
                statement.executeUpdate("INSERT INTO "+database.table("product_channels")+"(id,owner_id,handle,display_name,description) VALUES('"+channel+"','"+owner+"','questions-before-v10','기존 채널','이전 소개')");
                statement.executeUpdate("INSERT INTO "+database.table("product_polls")+"(id,channel_id,broadcast_id,path,broadcast_instance_id,question,created_at_ms,ends_at_ms,closed_at_ms,close_reason,version) VALUES('"+poll+"','"+channel+"','"+"a".repeat(32)+"','source','"+UUID.randomUUID()+"','보존할 투표',1794442212345,1794442272345,1794442212346,'manual',1)");
                statement.executeUpdate("INSERT INTO "+database.table("product_poll_options")+"(id,poll_id,position,text) VALUES('"+option+"','"+poll+"',0,'선택 보존')");
                statement.executeUpdate("INSERT INTO "+database.table("product_poll_votes")+"(poll_id,user_id,option_id,created_at_ms) VALUES('"+poll+"','"+viewer+"','"+option+"',1794442212346)");
            }
            assertEquals(2,database.configuration().load().migrate().migrationsExecuted);
            assertEquals(1,database.number("SELECT count(*) FROM "+database.table("product_polls")+" WHERE id='"+poll+"' AND question='보존할 투표' AND close_reason='manual' AND version=1"));
            assertEquals(1,database.number("SELECT count(*) FROM "+database.table("product_poll_votes")+" WHERE poll_id='"+poll+"' AND user_id='"+viewer+"' AND option_id='"+option+"'"));
            assertEquals(0,database.number("SELECT count(*) FROM "+database.table("product_questions")));
            try(var statement=database.connection.createStatement()){
                String fields="(id,channel_id,author_id,client_request_id,broadcast_id,path,broadcast_instance_id,text,pinned,created_at_ms,updated_at_ms)";
                String data="'"+channel+"','"+viewer+"','"+request+"','"+"a".repeat(32)+"','source','"+UUID.randomUUID()+"','기본 비공개 질문',true,1794442212345,1794442212345";
                statement.executeUpdate("INSERT INTO "+database.table("product_questions")+fields+" VALUES('"+first+"',"+data+")");
                assertThrows(SQLException.class,()->statement.executeUpdate("INSERT INTO "+database.table("product_questions")+fields+" VALUES('"+second+"',"+data+")"));
                assertThrows(SQLException.class,()->statement.executeUpdate("UPDATE "+database.table("product_questions")+" SET answer='잘못된 시간 없는 답변' WHERE id='"+first+"'"));
                String another="'"+channel+"','"+viewer+"','"+UUID.randomUUID()+"','"+"b".repeat(32)+"','source','"+UUID.randomUUID()+"','동시 고정 금지',true,1794442212346,1794442212346";
                assertThrows(SQLException.class,()->statement.executeUpdate("INSERT INTO "+database.table("product_questions")+fields+" VALUES('"+second+"',"+another+")"));
                statement.executeUpdate("UPDATE "+database.table("product_questions")+" SET answer='답변 보존',answered_at_ms=1794442212346 WHERE id='"+first+"'");
                statement.executeUpdate("DELETE FROM "+database.table("product_accounts")+" WHERE id='"+viewer+"'");
            }
            assertEquals(0,database.number("SELECT count(*) FROM "+database.table("product_questions")));
            assertEquals(1,database.number("SELECT count(*) FROM "+database.table("product_channels")+" WHERE id='"+channel+"' AND description='이전 소개'"));
        }
    }
    @Test void pointsMigrationPreservesPrivateAnswersAndConstrainsBalancesAndRefundReceipts() throws Exception {
        try(Database database=Database.create()){
            assertEquals(10,database.configuration().target("10").load().migrate().migrationsExecuted);
            UUID owner=UUID.randomUUID(),viewer=UUID.randomUUID(),channel=UUID.randomUUID(),question=UUID.randomUUID(),reward=UUID.randomUUID(),redemption=UUID.randomUUID(),instance=UUID.randomUUID();
            try(var statement=database.connection.createStatement()){
                statement.executeUpdate("INSERT INTO "+database.table("product_accounts")+"(id,email,password_hash,display_name) VALUES('"+owner+"','points-owner@example.invalid','hash','기존 소유자'),('"+viewer+"','points-viewer@example.invalid','hash','기존 시청자')");
                statement.executeUpdate("INSERT INTO "+database.table("product_channels")+"(id,owner_id,handle,display_name) VALUES('"+channel+"','"+owner+"','points-before-v11','기존 채널')");
                statement.executeUpdate("INSERT INTO "+database.table("product_questions")+"(id,channel_id,author_id,client_request_id,broadcast_id,path,broadcast_instance_id,text,answer,answered_at_ms,pinned,created_at_ms,updated_at_ms,version) VALUES('"+question+"','"+channel+"','"+viewer+"','"+UUID.randomUUID()+"','"+"a".repeat(32)+"','source','"+instance+"','기존 비공개 질문','기존 답변',1794442212346,true,1794442212345,1794442212346,3)");
            }
            assertEquals(1,database.configuration().load().migrate().migrationsExecuted);
            assertEquals(1,database.number("SELECT count(*) FROM "+database.table("product_questions")+" WHERE id='"+question+"' AND answer='기존 답변' AND pinned AND version=3"));
            for(String table:java.util.List.of("product_rewards","product_point_wallets","product_redemptions","product_point_ledger"))assertEquals(0,database.number("SELECT count(*) FROM "+database.table(table)));
            try(var statement=database.connection.createStatement()){
                statement.executeUpdate("INSERT INTO "+database.table("product_rewards")+"(id,channel_id,client_request_id,create_payload,name,points,redemption_limit,enabled,created_at_ms,updated_at_ms) VALUES('"+reward+"','"+channel+"','"+UUID.randomUUID()+"','{}','실제 보상',10,'once_per_broadcast',true,1794442212345,1794442212345)");
                statement.executeUpdate("INSERT INTO "+database.table("product_point_wallets")+"(channel_id,user_id,balance) VALUES('"+channel+"','"+viewer+"',10)");
                assertThrows(SQLException.class,()->statement.executeUpdate("UPDATE "+database.table("product_point_wallets")+" SET balance=-1"));
                assertThrows(SQLException.class,()->statement.executeUpdate("UPDATE "+database.table("product_point_wallets")+" SET pending_watch_ms=60000"));
                String columns="(id,channel_id,reward_id,user_id,client_request_id,requested_reward_version,reward_name,points,once_per_broadcast,broadcast_id,path,broadcast_instance_id,created_at_ms,updated_at_ms)";
                String values="'"+channel+"','"+reward+"','"+viewer+"','"+UUID.randomUUID()+"',0,'가격 이름 보존',10,true,'"+"a".repeat(32)+"','source','"+instance+"',1794442212346,1794442212346";
                statement.executeUpdate("INSERT INTO "+database.table("product_redemptions")+columns+" VALUES('"+redemption+"',"+values+")");
                String another="'"+channel+"','"+reward+"','"+viewer+"','"+UUID.randomUUID()+"',0,'중복 신청 금지',10,true,'"+"a".repeat(32)+"','source','"+instance+"',1794442212347,1794442212347";
                assertThrows(SQLException.class,()->statement.executeUpdate("INSERT INTO "+database.table("product_redemptions")+columns+" VALUES('"+UUID.randomUUID()+"',"+another+")"));
                String ledger="(id,channel_id,user_id,kind,delta,balance_after,label,redemption_id,created_at_ms)";
                statement.executeUpdate("INSERT INTO "+database.table("product_point_ledger")+ledger+" VALUES('"+UUID.randomUUID()+"','"+channel+"','"+viewer+"','refund',10,10,'한 번 환불','"+redemption+"',1794442212347)");
                assertThrows(SQLException.class,()->statement.executeUpdate("INSERT INTO "+database.table("product_point_ledger")+ledger+" VALUES('"+UUID.randomUUID()+"','"+channel+"','"+viewer+"','refund',10,20,'중복 환불','"+redemption+"',1794442212348)"));
                assertThrows(SQLException.class,()->statement.executeUpdate("INSERT INTO "+database.table("product_point_ledger")+ledger+" VALUES('"+UUID.randomUUID()+"','"+channel+"','"+viewer+"','watch',-10,0,'잘못된 적립',null,1794442212348)"));
                statement.executeUpdate("DELETE FROM "+database.table("product_accounts")+" WHERE id='"+viewer+"'");
            }
            for(String table:java.util.List.of("product_point_wallets","product_redemptions","product_point_ledger"))assertEquals(0,database.number("SELECT count(*) FROM "+database.table(table)));
        }
    }
    @Test void changedAppliedSqlFailsValidationBeforeAnyNewMigrationRuns() throws Exception {
        try (Database database = Database.create()) {
            for (String name : new String[] { "V1__accounts_channels_follows.sql", "V2__signup_consents.sql", "V3__broadcast_schedules.sql", "V4__watch_history.sql", "V5__channel_profiles_reports.sql", "V6__report_management.sql", "V7__product_notifications.sql", "V8__channel_chat_moderation.sql", "V9__channel_polls.sql", "V10__channel_questions.sql", "V11__channel_points_rewards.sql" }) {
                try (var input = getClass().getResourceAsStream("/db/migration/" + name)) {
                    assertNotNull(input); Files.copy(input, temporary.resolve(name));
                }
            }
            String location = "filesystem:" + temporary.toAbsolutePath().toString().replace('\\', '/');
            Flyway original = database.configuration().locations(location).load();
            assertEquals(11, original.migrate().migrationsExecuted);
            Path changed = temporary.resolve("V1__accounts_channels_follows.sql");
            Files.writeString(changed, Files.readString(changed) + "\nCREATE TABLE checksum_changed_probe (id integer);\n", StandardCharsets.UTF_8);
            Files.writeString(temporary.resolve("V12__must_not_run.sql"), "CREATE TABLE pending_migration_probe (id integer);\n", StandardCharsets.UTF_8);
            Flyway changedSql = database.configuration().locations(location).load();
            var validation = changedSql.validateWithResult();
            assertFalse(validation.validationSuccessful);
            assertTrue(validation.invalidMigrations.stream().anyMatch(migration -> migration.version.equals("1")));
            assertThrows(FlywayException.class, changedSql::migrate);
            assertEquals(11, database.number("SELECT count(*) FROM " + database.table("flyway_schema_history") + " WHERE success"));
            assertEquals(0, database.number("SELECT count(*) FROM information_schema.tables WHERE table_schema='" + database.schema + "' AND table_name IN ('checksum_changed_probe','pending_migration_probe')"));
        }
    }

    private static final class Database implements AutoCloseable {
        private final String url, username, password, schema;
        private final Connection connection;
        private Database(String url, String username, String password, String schema, Connection connection) {
            this.url = url; this.username = username; this.password = password; this.schema = schema; this.connection = connection;
        }
        static Database create() throws Exception {
            JsonNode config = JsonMapper.builder().build().readTree(Files.readAllBytes(Path.of(System.getenv("FRAME_PRODUCT_TEST_CONFIG"))));
            String url = config.path("verifyDbUrl").asString();
            URI address = URI.create(url.startsWith("jdbc:") ? url.substring(5) : "invalid:");
            if (!address.getScheme().equals("postgresql") || !"127.0.0.1".equals(address.getHost()) || (address.getPort() != 15432 && address.getPort() != 25432)
                    || address.getRawUserInfo() != null || address.getRawQuery() != null || address.getRawFragment() != null
                    || !address.getPath().matches("/frame_product_verify(?:_[a-zA-Z0-9_]+)?")) throw new IllegalStateException("Only a loopback verification database is allowed");
            String schema = "migration_verify_" + UUID.randomUUID().toString().replace("-", "");
            String username = config.path("dbUsername").asString(), password = config.path("dbPassword").asString();
            Connection connection = DriverManager.getConnection(url, username, password);
            try (var statement = connection.createStatement()) { statement.execute("CREATE SCHEMA " + schema); }
            catch (Exception failure) { connection.close(); throw failure; }
            return new Database(url, username, password, schema, connection);
        }
        FluentConfiguration configuration() {
            return Flyway.configure().dataSource(url, username, password).locations("classpath:db/migration")
                    .schemas(schema).defaultSchema(schema).createSchemas(false).cleanDisabled(true).baselineOnMigrate(false).validateOnMigrate(true);
        }
        String table(String name) { return schema + "." + name; }
        int number(String query) throws SQLException {
            try (var statement = connection.createStatement(); var result = statement.executeQuery(query)) { assertTrue(result.next()); return result.getInt(1); }
        }
        @Override public void close() throws Exception {
            try {
                if (!schema.matches("migration_verify_[a-f0-9]{32}")) throw new IllegalStateException("Unowned verification schema");
                try (var statement = connection.createStatement()) { statement.execute("DROP SCHEMA " + schema + " CASCADE"); }
            } finally { connection.close(); }
        }
    }
}
