package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;

import java.util.UUID;
import org.junit.jupiter.api.Test;

class ChannelRecordingsTest {
    @Test void completeFilesNeedBothConservativeOwnershipBoundaries(){
        assertTrue(ChannelRecordings.contained(2000,3000L,1000,6000));
        assertFalse(ChannelRecordings.contained(1999,3000L,1000,6000));
        assertFalse(ChannelRecordings.contained(2000,3001L,1000,6000));
        assertFalse(ChannelRecordings.contained(2000,null,1000,6000));
        assertFalse(ChannelRecordings.contained(2000,0L,1000,6000));
        assertFalse(ChannelRecordings.contained(Long.MAX_VALUE-1,3000L,1000,Long.MAX_VALUE));
    }
    @Test void transfersHaveIndependentOwnerAndGlobalBoundsAndReleaseSlots(){
        RecordingController controller=new RecordingController(null,null,null);UUID one=UUID.randomUUID(),two=UUID.randomUUID(),three=UUID.randomUUID();
        assertTrue(controller.enter(one));assertTrue(controller.enter(one));assertFalse(controller.enter(one));
        assertTrue(controller.enter(two));assertTrue(controller.enter(two));assertFalse(controller.enter(three));
        controller.leave(one);assertTrue(controller.enter(three));controller.leave(one);controller.leave(two);controller.leave(two);controller.leave(three);
        assertTrue(controller.enter(one));
    }
}
