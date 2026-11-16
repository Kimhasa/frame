package frame.api.account;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

/** Private product aggregates of server observations; no viewer account, session, address or device is stored. */
@Service
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public class ChannelAnalytics {
    public record Summary(long broadcastCount,long broadcastDurationMs,long observedDurationMs,Double averageConcurrent,Integer peakConcurrent){}
    public record Daily(String date,long broadcastCount,long broadcastDurationMs,long observedDurationMs,Double averageConcurrent,Integer peakConcurrent){}
    public record Item(UUID id,String broadcastId,String path,String title,long startedAtMs,long lastObservedAtMs,Long endedAtMs,
                       String status,String endReason,long broadcastDurationMs,long observedDurationMs,Double averageConcurrent,Integer peakConcurrent){}
    public record Page(UUID userId,int periodDays,String fromDate,String toDate,long serverNowMs,Long collectionStartedAtMs,
                       Summary summary,List<Daily> daily,List<Item> items,String nextCursor){}
    record Observation(UUID id,String broadcast,String path,String title,String source,int viewers){}
    record Previous(UUID id,UUID channel,String source,long at,int viewers,boolean ready){}
    record Span(LocalDate day,long duration){}
    record Cursor(long at,UUID id){}
    record Filters(int period,String query,LocalDate from,LocalDate to,String context,Cursor cursor,int limit){}
    private static final ZoneId SEOUL=ZoneId.of("Asia/Seoul");
    private static final String UUID_PATTERN="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    private final JdbcClient sql;
    public ChannelAnalytics(JdbcClient sql){this.sql=sql;}

    /** Only the one collector for this API database calls this at process startup. Never extrapolate to restart time. */
    @Transactional(timeout=3) public void recover(){
        bounded();
        sql.sql("UPDATE product_broadcast_analytics SET status='interrupted',end_reason='server_restart',ended_at_ms=last_observed_at_ms WHERE status='live'").update();
    }
    @Transactional(timeout=4) public void sample(List<Observation> observations,Map<UUID,String> active,long now,boolean continuous){
        bounded();
        var previous=new HashMap<UUID,Previous>();
        var observed=observations.stream().map(Observation::id).collect(java.util.stream.Collectors.toSet());
        for(Previous row:sql.sql("SELECT id,channel_id,source_session,last_observed_at_ms,last_concurrent,interval_ready FROM product_broadcast_analytics WHERE status='live' FOR UPDATE")
                .query((r,i)->new Previous(r.getObject("id",UUID.class),r.getObject("channel_id",UUID.class),r.getString("source_session"),r.getLong("last_observed_at_ms"),r.getInt("last_concurrent"),r.getBoolean("interval_ready"))).list()){
            String current=active.get(row.id());
            if(current==null)close(row.id(),"ended","broadcast_ended");
            else{
                // OBS can reconnect inside the registry grace with the same broadcast instance. Pause the interval,
                // rather than terminally ending that broadcast or bridging the missing/source-replacement interval.
                if(!observed.contains(row.id())){
                    sql.sql("UPDATE product_broadcast_analytics SET interval_ready=false WHERE id=:id").param("id",row.id()).update();
                    row=new Previous(row.id(),row.channel(),row.source(),row.at(),row.viewers(),false);
                }
                previous.put(row.id(),row);
            }
        }
        for(Observation observation:observations){
            Previous before=previous.get(observation.id());
            if(before==null){
                // A completed instance is immutable, including a ready source reappearing with the same sender id.
                if(sql.sql("SELECT EXISTS(SELECT 1 FROM product_broadcast_analytics WHERE id=:id)").param("id",observation.id()).query(Boolean.class).single())continue;
                UUID channel=sql.sql("SELECT id FROM product_channels WHERE stream_path=:path").param("path",observation.path()).query(UUID.class).optional().orElse(null);
                if(channel==null)continue;
                sql.sql("""
                        INSERT INTO product_broadcast_analytics(id,channel_id,broadcast_id,path,title,source_session,started_at_ms,last_observed_at_ms,peak_concurrent,last_concurrent)
                        VALUES(:id,:channel,:broadcast,:path,:title,:source,:now,:now,:viewers,:viewers)
                        """).param("id",observation.id()).param("channel",channel).param("broadcast",observation.broadcast()).param("path",observation.path())
                        .param("title",observation.title().replace('\0','\uFFFD')).param("source",observation.source()).param("now",now).param("viewers",observation.viewers()).update();
                day(observation.id(),date(now),0,0,observation.viewers());
                continue;
            }
            if(!sql.sql("SELECT EXISTS(SELECT 1 FROM product_channels WHERE id=:id AND stream_path=:path)").param("id",before.channel()).param("path",observation.path()).query(Boolean.class).single()){
                close(before.id(),"ended","channel_disconnected");continue;
            }
            if(now<=before.at())continue;
            long duration=interval(before.at(),now,continuous&&before.ready()&&before.source().equals(observation.source())),viewerMs=duration*before.viewers();
            sql.sql("""
                    UPDATE product_broadcast_analytics SET title=:title,last_observed_at_ms=:now,last_concurrent=:viewers,source_session=:source,interval_ready=true,
                      broadcast_duration_ms=broadcast_duration_ms+:duration,observed_duration_ms=observed_duration_ms+:duration,
                      viewer_ms=viewer_ms+:viewer,peak_concurrent=greatest(peak_concurrent,:viewers) WHERE id=:id AND status='live'
                    """).param("title",observation.title().replace('\0','\uFFFD')).param("now",now).param("viewers",observation.viewers()).param("source",observation.source())
                    .param("duration",duration).param("viewer",viewerMs).param("id",observation.id()).update();
            for(Span span:split(now-duration,now))day(observation.id(),span.day(),span.duration(),span.duration()*before.viewers(),before.viewers());
            // The current point is observed even if no interval can safely be accumulated.
            day(observation.id(),date(now),0,0,observation.viewers());
        }
    }
    private void bounded(){sql.sql("SET LOCAL statement_timeout='1500ms'").update();sql.sql("SET LOCAL lock_timeout='1000ms'").update();}
    private void close(UUID id,String status,String reason){sql.sql("UPDATE product_broadcast_analytics SET status=:status,end_reason=:reason,ended_at_ms=last_observed_at_ms WHERE id=:id AND status='live'").param("status",status).param("reason",reason).param("id",id).update();}
    private void day(UUID id,LocalDate date,long duration,long viewer,int peak){
        sql.sql("""
                INSERT INTO product_broadcast_analytics_daily(broadcast_id,day,broadcast_duration_ms,observed_duration_ms,viewer_ms,peak_concurrent)
                VALUES(:id,:day,:duration,:duration,:viewer,:peak)
                ON CONFLICT(broadcast_id,day) DO UPDATE SET broadcast_duration_ms=product_broadcast_analytics_daily.broadcast_duration_ms+excluded.broadcast_duration_ms,
                  observed_duration_ms=product_broadcast_analytics_daily.observed_duration_ms+excluded.observed_duration_ms,
                  viewer_ms=product_broadcast_analytics_daily.viewer_ms+excluded.viewer_ms,peak_concurrent=greatest(product_broadcast_analytics_daily.peak_concurrent,excluded.peak_concurrent)
                """).param("id",id).param("day",date).param("duration",duration).param("viewer",viewer).param("peak",peak).update();
    }
    static long interval(long before,long now,boolean continuous){long elapsed=now-before;return continuous&&elapsed>0&&elapsed<=15_000?Math.min(5_000,elapsed):0;}
    static List<Span> split(long from,long to){
        List<Span> result=new ArrayList<>();
        while(from<to){LocalDate day=date(from);long until=Math.min(to,day.plusDays(1).atStartOfDay(SEOUL).toInstant().toEpochMilli());result.add(new Span(day,until-from));from=until;}
        return result;
    }
    private static LocalDate date(long at){return Instant.ofEpochMilli(at).atZone(SEOUL).toLocalDate();}

    @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ) public Page list(UUID owner,String period,String query,String from,String to,String cursor,int limit){
        long now=System.currentTimeMillis();Filters filters=filters(owner,period,query,from,to,cursor,limit,now);
        if(!sql.sql("SELECT EXISTS(SELECT 1 FROM product_accounts WHERE id=:owner)").param("owner",owner).query(Boolean.class).single())throw new ProductProblem(401,"UNAUTHENTICATED","다시 로그인해 주세요.");
        UUID channel=sql.sql("SELECT id FROM product_channels WHERE owner_id=:owner").param("owner",owner).query(UUID.class).optional().orElse(null);
        String selected="""
                SELECT a.*,sum(d.broadcast_duration_ms)::bigint AS selected_duration,sum(d.observed_duration_ms)::bigint AS selected_observed,
                  sum(d.viewer_ms)::bigint AS selected_viewer,max(d.peak_concurrent) AS selected_peak
                FROM product_broadcast_analytics a JOIN product_broadcast_analytics_daily d ON d.broadcast_id=a.id
                WHERE a.channel_id=:channel AND d.day>=:from AND d.day<=:to AND position(lower(:q) IN lower(a.title))>0 GROUP BY a.id
                """;
        Summary summary=request("WITH selected AS ("+selected+") SELECT count(*) AS count,coalesce(sum(selected_duration),0)::bigint AS duration,coalesce(sum(selected_observed),0)::bigint AS observed,coalesce(sum(selected_viewer),0)::bigint AS viewer,max(selected_peak) AS peak FROM selected",channel,filters)
                .query((r,i)->new Summary(r.getLong("count"),r.getLong("duration"),r.getLong("observed"),average(r.getLong("viewer"),r.getLong("observed")),r.getObject("peak",Integer.class))).single();
        var days=new HashMap<String,Daily>();
        request("""
                SELECT d.day,count(*) AS count,sum(d.broadcast_duration_ms)::bigint AS duration,sum(d.observed_duration_ms)::bigint AS observed,
                  sum(d.viewer_ms)::bigint AS viewer,max(d.peak_concurrent) AS peak FROM product_broadcast_analytics a
                JOIN product_broadcast_analytics_daily d ON d.broadcast_id=a.id
                WHERE a.channel_id=:channel AND d.day>=:from AND d.day<=:to AND position(lower(:q) IN lower(a.title))>0 GROUP BY d.day
                """,channel,filters).query((r,i)->new Daily(r.getDate("day").toLocalDate().toString(),r.getLong("count"),r.getLong("duration"),r.getLong("observed"),average(r.getLong("viewer"),r.getLong("observed")),r.getObject("peak",Integer.class))).list().forEach(day->days.put(day.date(),day));
        List<Daily> daily=new ArrayList<>();
        for(LocalDate day=filters.from();!day.isAfter(filters.to());day=day.plusDays(1))daily.add(days.getOrDefault(day.toString(),new Daily(day.toString(),0,0,0,null,null)));
        var list=request("WITH selected AS ("+selected+") SELECT * FROM selected "+(filters.cursor()==null?"":"WHERE (started_at_ms,id)<(:at,:id) ")+"ORDER BY started_at_ms DESC,id DESC LIMIT :limit",channel,filters).param("limit",limit+1);
        if(filters.cursor()!=null)list.param("at",filters.cursor().at()).param("id",filters.cursor().id());
        List<Item> rows=list.query(this::item).list();boolean more=rows.size()>limit;List<Item> items=more?List.copyOf(rows.subList(0,limit)):rows;
        long first=sql.sql("SELECT coalesce(min(started_at_ms),0) FROM product_broadcast_analytics WHERE channel_id=:channel").param("channel",channel,java.sql.Types.OTHER).query(Long.class).single();
        Item last=more?items.getLast():null;
        return new Page(owner,filters.period(),filters.from().toString(),filters.to().toString(),now,first==0?null:first,summary,daily,items,last==null?null:encode(last.startedAtMs(),last.id(),filters.context()));
    }
    private JdbcClient.StatementSpec request(String statement,UUID channel,Filters filters){return sql.sql(statement).param("channel",channel,java.sql.Types.OTHER).param("from",filters.from()).param("to",filters.to()).param("q",filters.query());}
    private Item item(ResultSet row,int index)throws SQLException{return new Item(row.getObject("id",UUID.class),row.getString("broadcast_id"),row.getString("path"),row.getString("title"),row.getLong("started_at_ms"),row.getLong("last_observed_at_ms"),row.getObject("ended_at_ms",Long.class),row.getString("status"),row.getString("end_reason"),row.getLong("selected_duration"),row.getLong("selected_observed"),average(row.getLong("selected_viewer"),row.getLong("selected_observed")),row.getObject("selected_peak",Integer.class));}
    static Double average(long viewer,long observed){return observed==0?null:Math.round((double)viewer/observed*100)/100.0;}
    static Filters filters(UUID owner,String period,String query,String from,String to,String cursor,int limit,long now){
        if(!List.of("7","30").contains(period)||limit<1||limit>100||query.codePointCount(0,query.length())>120||query.codePoints().anyMatch(Character::isISOControl))throw invalidFilter();
        int days=Integer.parseInt(period);LocalDate today=date(now),earliest=today.minusDays(days-1),start=from.isEmpty()?earliest:day(from),end=to.isEmpty()?today:day(to);
        if(start.isBefore(earliest)||end.isAfter(today)||start.isAfter(end))throw invalidFilter();
        String q=query.strip().toLowerCase(Locale.ROOT),context=hash(owner+"\n"+days+"\n"+start+"\n"+end+"\n"+limit+"\n"+q);
        return new Filters(days,q,start,end,context,decode(cursor,context),limit);
    }
    private static LocalDate day(String input){try{if(!input.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}"))throw invalidFilter();return LocalDate.parse(input);}catch(DateTimeException failure){throw invalidFilter();}}
    static String encode(long at,UUID id,String context){return Base64.getUrlEncoder().withoutPadding().encodeToString((at+":"+id+":"+context).getBytes(StandardCharsets.UTF_8));}
    static Cursor decode(String input,String context){
        if(input.isEmpty())return null;
        try{
            if(!input.matches("[A-Za-z0-9_-]{1,200}"))throw new IllegalArgumentException();
            String value=new String(Base64.getUrlDecoder().decode(input),StandardCharsets.UTF_8);
            if(!value.matches("[1-9][0-9]{0,14}:"+UUID_PATTERN+":[0-9a-f]{64}"))throw new IllegalArgumentException();
            String[] parts=value.split(":");long at=Long.parseLong(parts[0]);
            if(at>253402300799999L||!parts[2].equals(context))throw new IllegalArgumentException();
            return new Cursor(at,UUID.fromString(parts[1]));
        }catch(IllegalArgumentException failure){throw new ProductProblem(400,"INVALID_ANALYTICS_CURSOR","통계 목록을 새로 불러와 주세요.");}
    }
    private static String hash(String value){try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));}catch(java.security.NoSuchAlgorithmException impossible){throw new IllegalStateException(impossible);}}
    private static ProductProblem invalidFilter(){return new ProductProblem(400,"INVALID_ANALYTICS_FILTER","통계 검색 조건과 기간을 확인해 주세요.");}
}
