package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;

import frame.api.TestProps;
import frame.api.broadcast.BroadcastRegistry;
import frame.api.broadcast.PublisherTokens;
import frame.api.mediamtx.MediaPath;
import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class ChannelAnalyticsTest {
    @Test void restartCollectsANewBroadcastEvenWhenTheSameRtmpPublisherIsOlderThanTheApi()throws Exception{
        long now=System.currentTimeMillis(),publisherReady=now-60_000;
        var tokens=new PublisherTokens(TestProps.props());
        var restarted=new BroadcastRegistry(TestProps.props(),tokens,event->{});
        var message=tools.jackson.databind.json.JsonMapper.builder().build().valueToTree(java.util.Map.of("v",1,"type","announce","item",java.util.Map.of("id","a".repeat(32),"path","screen-01","title","재시작 후 관찰","publisher","OBS","width",320,"height",180,"fps",15,"startedAtMs",now)));
        assertEquals(204,restarted.announce(message,tokens.indexOf("Bearer "+TestProps.TOKEN_A)).status());
        var broadcast=restarted.byPath("screen-01");
        var oldPublisher=new MediaPath(true,publisherReady,java.util.List.of("H264"),320,180,"Baseline","3.1","rtmpConn",0,0,0,0,0,"same-publisher");
        assertFalse(AnalyticsCollector.observed(broadcast,oldPublisher)); // The newly registered instance has not observed this source yet.
        broadcast.observe(oldPublisher,false);
        assertTrue(broadcast.startedAtRelayMs-oldPublisher.readyMs()>10_000);
        assertFalse(ProductNotifications.consistent(broadcast,oldPublisher)); // Preserve the existing live-alert rule.
        assertTrue(AnalyticsCollector.observed(broadcast,oldPublisher));
        assertFalse(AnalyticsCollector.observed(broadcast,new MediaPath(true,publisherReady,java.util.List.of("H264"),320,180,"Baseline","3.1","rtmpConn",0,0,0,0,0,"different-publisher")));
        assertFalse(AnalyticsCollector.observed(broadcast,null));
        assertFalse(AnalyticsCollector.observed(broadcast,new MediaPath(false,publisherReady,java.util.List.of("H264"),320,180,"Baseline","3.1","rtmpConn",0,0,0,0,0,"same-publisher")));
    }
    @Test void collectionGapsNeverBecomeImaginaryWatchTime(){
        assertEquals(5000,ChannelAnalytics.interval(1000,6000,true));
        assertEquals(5000,ChannelAnalytics.interval(1000,7000,true));
        assertEquals(1234,ChannelAnalytics.interval(1000,2234,true));
        assertEquals(0,ChannelAnalytics.interval(1000,17000,true));
        assertEquals(0,ChannelAnalytics.interval(1000,6000,false));
        assertEquals(0,ChannelAnalytics.interval(1000,1000,true));
        assertEquals(0,ChannelAnalytics.interval(1000,900,true));
        assertNull(ChannelAnalytics.average(0,0));
        assertEquals(0.0,ChannelAnalytics.average(0,5000));
        assertEquals(1.67,ChannelAnalytics.average(10000,6000));
    }
    @Test void koreanMidnightPartitionsTheMeasuredIntervalExactly(){
        long before=Instant.parse("2026-11-15T14:59:58Z").toEpochMilli(),after=before+5000;
        var days=ChannelAnalytics.split(before,after);
        assertEquals(2,days.size());
        assertEquals(LocalDate.parse("2026-11-15"),days.get(0).day());assertEquals(2000,days.get(0).duration());
        assertEquals(LocalDate.parse("2026-11-16"),days.get(1).day());assertEquals(3000,days.get(1).duration());
        assertTrue(ChannelAnalytics.split(after,after).isEmpty());
        assertEquals(5000,days.stream().mapToLong(ChannelAnalytics.Span::duration).sum());
    }
    @Test void periodAndCursorAreBoundToOwnerAndAppliedFilters(){
        UUID owner=UUID.randomUUID();long now=Instant.parse("2026-11-15T15:01:00Z").toEpochMilli();
        var filters=ChannelAnalytics.filters(owner,"7"," 개발 ","","","",20,now);
        assertEquals(LocalDate.parse("2026-11-10"),filters.from());assertEquals(LocalDate.parse("2026-11-16"),filters.to());
        assertEquals("개발",filters.query());UUID id=UUID.randomUUID();
        String cursor=ChannelAnalytics.encode(now,id,filters.context());
        assertEquals(id,ChannelAnalytics.filters(owner,"7","개발","2026-11-10","2026-11-16",cursor,20,now).cursor().id());
        assertEquals("INVALID_ANALYTICS_CURSOR",assertThrows(ProductProblem.class,()->ChannelAnalytics.filters(UUID.randomUUID(),"7","개발","","",cursor,20,now)).code);
        assertThrows(ProductProblem.class,()->ChannelAnalytics.filters(owner,"30","개발","","",cursor,20,now));
        assertThrows(ProductProblem.class,()->ChannelAnalytics.filters(owner,"7","다른 검색","","",cursor,20,now));
        for(String input:new String[]{"31","0","07","bad"})assertThrows(ProductProblem.class,()->ChannelAnalytics.filters(owner,input,"","","","",20,now));
        for(String[] dates:new String[][]{{"2026-11-09",""},{"","2026-11-17"},{"2026-11-16","2026-11-15"},{"2026-02-30",""}})assertThrows(ProductProblem.class,()->ChannelAnalytics.filters(owner,"7","",dates[0],dates[1],"",20,now));
        assertThrows(ProductProblem.class,()->ChannelAnalytics.filters(owner,"7","bad\nquery","","","",20,now));
        assertThrows(ProductProblem.class,()->ChannelAnalytics.filters(owner,"7","x".repeat(121),"","","",20,now));
        assertThrows(ProductProblem.class,()->ChannelAnalytics.filters(owner,"7","","","","",101,now));
    }
}
