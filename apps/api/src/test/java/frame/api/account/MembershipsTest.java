package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;

import java.time.Instant;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class MembershipsTest {
    private static final JsonMapper JSON=JsonMapper.builder().build();
    @Test void missingProviderConfigurationLeavesBillingReconciliationAndKeyDeletionUnclaimed(){
        // No database is available to this instance: unavailable credentials must not even claim or mutate a due row.
        var gateway=new MembershipGateway();
        var memberships=new Memberships(null,JSON,gateway,org.mockito.Mockito.mock(org.springframework.transaction.PlatformTransactionManager.class));
        assertFalse(gateway.configured());
        assertDoesNotThrow(()->{assertNull(memberships.claimCharge());assertNull(memberships.claimLookup());assertNull(memberships.claimDeletion());});
    }
    @Test void calendarMonthsUseKoreanTimeAndClampMonthEndsInsteadOfThirtyDays(){
        assertEquals(Instant.parse("2027-02-28T14:30:00Z").toEpochMilli(),Memberships.monthAfter(Instant.parse("2027-01-31T14:30:00Z").toEpochMilli()));
        assertEquals(Instant.parse("2028-02-29T14:30:00Z").toEpochMilli(),Memberships.monthAfter(Instant.parse("2028-01-31T14:30:00Z").toEpochMilli()));
        assertEquals(Instant.parse("2026-11-30T15:30:00Z").toEpochMilli(),Memberships.monthAfter(Instant.parse("2026-10-31T15:30:00Z").toEpochMilli()));
    }
    @Test void benefitsArePlainBoundedUnicodeText(){
        assertEquals("가\n혜택",Memberships.benefits(JSON.valueToTree(" 가\r\n혜택 ")));
        assertEquals("",Memberships.benefits(JSON.valueToTree(" ")));
        for(String value:new String[]{"a".repeat(501),"가\u0000나","숨김\u200b문자"})assertThrows(ProductProblem.class,()->Memberships.benefits(JSON.valueToTree(value)));
        assertThrows(ProductProblem.class,()->Memberships.benefits(JSON.valueToTree(4900)));
    }
    @Test void inclusiveKoreanDateRangeBecomesExclusiveNextMidnight(){
        long[] range=Memberships.dates("2026-11-17","2026-11-17");assertEquals(Instant.parse("2026-11-16T15:00:00Z").toEpochMilli(),range[0]);assertEquals(24*3600*1000,range[1]-range[0]);
        assertThrows(ProductProblem.class,()->Memberships.dates("2026-02-30",""));assertThrows(ProductProblem.class,()->Memberships.dates("2026-11-18","2026-11-17"));
    }
    @Test void requestIdsRequireFullUuidShape(){
        for(String value:new String[]{"1-1-1-1-1","","foreign","00000000-0000-0000-0000-00000000000z"})assertThrows(ProductProblem.class,()->Memberships.id(value));
        assertEquals(java.util.UUID.fromString("00000000-0000-0000-0000-000000000001"),Memberships.id("00000000-0000-0000-0000-000000000001"));
    }
}
