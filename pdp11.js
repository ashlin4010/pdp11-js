// Javascript PDP 11/70 Emulator v3.0
// written by Paul Nankervis
// Please send suggestions, fixes and feedback to paulnank@hotmail.com
//
// This code may be used freely provided the original author name is acknowledged in any modified source code
//
//
//
//
//
const
    IOBASE_VIRT = 0o160000,
    IOBASE_18BIT = 0o760000,
    IOBASE_UNIBUS = 0o17000000,
    IOBASE_22BIT = 0o17760000,
    MAX_MEMORY = IOBASE_UNIBUS - 16384, // Maximum memory address (need less memory for BSD 2.9 boot)
    MMU_BYTE_MODE = 1, // accessMode auto-increment length of 1 and flag for byte addressing
    MMU_READ = 16, // READ & WRITE bits used to indicate access type in memory operations
    MMU_WRITE = 32, // but beware lower 4 bits used as auto-increment length when getting virtual address
    MMU_LENGTH_MASK = 0xf, // Mask for operand length (which can be up to 8 for FPP)
    MMU_BYTE = 1, // Byte length in 4 bits
    MMU_WORD = 2, // Word length
    MMU_BYTE_READ = MMU_READ | MMU_BYTE, // Read flag with byte length
    MMU_WORD_READ = MMU_READ | MMU_WORD,
    MMU_BYTE_WRITE = MMU_WRITE | MMU_BYTE,
    MMU_WORD_WRITE = MMU_WRITE | MMU_WORD,
    MMU_BYTE_MODIFY = MMU_READ | MMU_WRITE | MMU_BYTE,
    MMU_WORD_MODIFY = MMU_READ | MMU_WRITE | MMU_WORD, // Read & write flags with word length
    STATE_RUN = 0, // Define legal values for CPU.runState (run, reset, wait, halt)
    STATE_RESET = 1,
    STATE_WAIT = 2,
    STATE_HALT = 3;


// Below are the CPU registers. At simplest level a PDP 11 program has 8 registers (0-5 are general, 6 is the stack
// pointer, and 7 is the PC), 4 condition codes (Negative, Zero, Overflow and Carry), up to 28K words of memory,
// and 4K of I/O page address space. All device I/O and access to other features (including memory management)
// is done through reference to the I/O page at the top of physical memory.
// Memory management enables 3 modes (Kernel, Supervisor and User) each of which have their own mapping of memory
// from a 17 bit virtual address (16 bits for instructions and 16 for data), to 22 bits of physical bus space.
// Thus a program virtual address space can be up to 32K words of instruction space and 32K words of data space.
// The distinction between these spaces is that references based on register 7 (the program counter) refer to
// instruction space, while all other references are to data space.
// I/O and control of devices is done by writing to device registers in the 4K words in the I/O page at the top
// of physical memory. This is implemented here by calling the access_iopage() function in module iopage.js.
// For example to send a character to the console terminal a program would write to the console transmit buffer
// at virtual address 177566 - assuming that this is mapped to bus address 17777566. Also located in the I/O page
// are things like the Program Status Word (PSW which contains CPU priority, memory management mode, condition
// codes etc), Memory Management registers, the Stack limit register, Program Interrupt register, each memory
// management mode stack pointer (R6), as well as two sets of general registers (selection by program status).
// Floating point arithmetic is handled by a separate module. It is implemented by calling the executeFPP()
// function in module fpp.js whenever a floating point instruction is encountered.
// Traps are implemented by the trap() function below. Traps read a new PC and PSW from a vector in kernel data
// space, and then save the old values on to the new mode stack. Software can resume processing at the end of an
// interrupt service routine by using an RTT or RTI instruction to restore the PC and PSW.
// The trap vector depends on the kind of trap, for example 4 for an odd address, 10 for an invalid instruction,
// or 20 when an IOT instruction is encountered.
// I/O traps occur when a device needs to signal attention, for example at the completion of an operation. In this
// case the device code calls the interrupt() function below to queue a trap to the appropriate trap vector
// with a priority code. When the CPU priority in the PSW falls below that interupt level then the device I/O
// trap will trigger.

var CPU = {
    controlReg: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // various control registers we don't really care about
    CPU_Error: 0,
    cpuType: 70,
    displayAddress: 0, // Address display for console operations
    displayPhysical: 0, // Physical address display for console operations
    displayRegister: 0, // Console display lights register (set by software)
    displayDataPaths: 0, // Console display data path (random except in console operations or non-run state)
    statusLights: 0x3000, // Need to remember console address error light status
    flagC: 0x10000, // PSW C bit
    flagN: 0x8000, // PSW N bit
    flagV: 0x8000, // PSW V bit
    flagZ: 0xffff, // ~ PSW Z bit
    loopCount: 1000, // Guess at number of instructions per 20ms loop (50Hz)
    memory: [], // Main memory (in words - addresses must be halved for indexing)
    modifyRegister: -1, // Remember the address of a register in a read/write (modify) cycle
    modifyAddress: -1, // If the register is < 0 then remember the memory physical address
    MMR0: 0, // MMU control registers
    MMR1: 0,
    MMR2: 0,
    MMR3: 0,
    MMR3Mask: [7, 7, 7, 7], // I&D page mask by mode from KSU bits in MMR3
    mmuEnable: 0, // MMU enable mask for MMU_READ and/or MMU_WRITE
    mmuLastPage: 0, // last used MMU page for MMR0 - 2 bits of mode and 4 bits of I/D page - used as an index into PAR/PDR
    mmuMode: 0, // current memory management mode (0=kernel,1=super,2=undefined,3=user)
    mmuPAR: [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, //0 kernel
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, //1 super
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, //2 illegal
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 //3 user
    ], // memory management PAR registers by mode
    mmuPDR: [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, //0 kernel
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, //1 super
        0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, // 2 illegal
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 //3 user
    ], // memory management PDR registers by mode
    PIR: 0, // Programmable interrupt register
    priorityReview: 1, // flag to mark if we need to check priority change
    PSW: 0xf, // PSW less flags C, N, V & Z
    registerAlt: [0, 0, 0, 0, 0, 0], // Alternate registers R0 - R5
    registerVal: [0, 0, 0, 0, 0, 0, 0, 0], // Current registers  R0 - R7
    stackLimit: 0xff, // stack overflow limit
    stackPointer: [0, 0, 0, 0], // Alternate R6 (kernel, super, illegal, user)
    switchRegister: 0, // console switch register
    trapMask: 0, // Mask of traps to be taken at the end of the current instruction
    trapPSW: -1, // PSW when first trap invoked - for tackling double traps
    unibusMap: [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ], // 32 unibus mapping registers
    runState: -1, // current machine state STATE_RUN, STATE_RESET, STATE_WAIT or STATE_HALT
    interruptQueue: [], // List of interrupts pending
};

function LOG_INSTRUCTION(instruction, format, name) {
    console.log((CPU.registerVal[7] - 2).toString(8) + " " + instruction.toString(8) + " " + name);
}

// Interrupts are stored in a queue in delay order with the delay expressed as
// a difference. For example if the delays were 0, 1, 0 then the first entry
// is active and both the second and third are waiting for one more instruction
// cycle to become active (which then trap when the CPU has a lower priority).
// If the current runState is WAIT then skip any delay and go straight to RUN.
// Note: Delay represents a number of instructions to execute before allowing an
// interrupt to become active. Nice idea to handle any problematic code which was
// written to know that a device could not interrupt immediately. However I don't
// think I have yet encountered this situation and perhaps the concept is a waste.
// Update: Instruction delays in the RK11 driver require this to make DOS 9 work!

function interrupt(delay, priority, vector, unit, callback, callarg) {
    "use strict";
    var i = CPU.interruptQueue.length;
    if (typeof callback == "undefined") {
        callback = null;
    }
    while (i-- > 0) { // Remove any matching entries
        if (CPU.interruptQueue[i].vector == vector && (unit < 0 || CPU.interruptQueue[i].unit == unit)) {
            if (i > 0) {
                CPU.interruptQueue[i - 1].delay += CPU.interruptQueue[i].delay;
            }
            CPU.interruptQueue.splice(i, 1);
            break;
        }
    }
    if (delay >= 0) { // Delay below 0 doesn't create queue entry
        i = CPU.interruptQueue.length; // queue in delay 'difference' order
        while (i-- > 0) {
            if (CPU.interruptQueue[i].delay > delay) {
                CPU.interruptQueue[i].delay -= delay;
                break;
            }
            delay -= CPU.interruptQueue[i].delay;
        }
        CPU.interruptQueue.splice(i + 1, 0, {
            "delay": CPU.runState == STATE_WAIT ? 0 : delay,
            "priority": priority & 0xe0,
            "vector": vector,
            "unit": unit < 0 ? 0 : unit,
            "callback": callback,
            "callarg": callarg
        });
        if (delay > 0 || (priority & 0xe0) > (CPU.PSW & 0xe0)) {
            CPU.priorityReview = 1; // Schedule an interrupt priority review if required
        }
        if (CPU.runState == STATE_WAIT) { // if currently in wait then resume
            CPU.runState = STATE_RUN;
            emulate(1000); // Kick start processor
        }
    }
}


// When a wait instruction is executed do a search through the interrupt list
// to see if we can run something (anything!) which has been delayed. If there is
// something to execute then we don't actually need to enter WAIT state.

function interruptWaitRelease() {
    "use strict";
    var savePSW, i;
    savePSW = CPU.PSW & 0xe0;
    i = CPU.interruptQueue.length;
    while (i-- > 0) {
        CPU.interruptQueue[i].delay = 0;
        if (CPU.interruptQueue[i].priority > (CPU.PSW & 0xe0)) {
            CPU.priorityReview = 1;
            return 1; // Found something that can run
        }
    }
    return 0; // No candidates found for WAIT release
}


// When the PSW, PIR or interrupt queue state have changed then it is time to review
// the list of pending interrupts to see if we can invoke one. If nothing changes
// then further reviews are not required until something does change. Changes include
// any delay decrement.
// Review is controlled by the flag CPU.priorityReview
// Interrupt callbacks allow custom device code to be called which can do special
// device handling - such as chaining RK11 seek interrupts. A callback will also return
// a flag to indicate whether the interrupt is still required - as will happen when
// the device interupt flag is reset while waiting for the interrupt to occur.
// However this quickly gets more complicated than desired! :-( Callbacks can themselves
// interact with the interrupt queue by deleting or creating new entries - breaking the
// loop to review the queue! As a result the loop count i can be thrown completely out of
// whack when a callback is encountered - which requires that the review loop be restarted
// from scratch! To re-find the queue entry containing the callback it must be marked before
// callback - here using a delay of -1, so that it can be found again (if it is even
// still in the queue). When re-encountered it will be deleted or the callback removed
// as determined by activeFlag.
// Sigh!

function interruptReview() {
    "use strict";
    var highPriority, high, i, activeFlag;
    CPU.priorityReview = 0;
    high = -1;
    highPriority = CPU.PIR & 0xe0;
    i = CPU.interruptQueue.length;
    while (--i >= 0) {
        if (CPU.interruptQueue[i].delay > 0) { // If delay then all following entries are also delayed
            CPU.interruptQueue[i].delay--; // Decrement one delay 'difference' per cycle
            CPU.priorityReview = 1;
            break; // End of loop when we hit delayed items
        }
        if (CPU.interruptQueue[i].callback) { // If there a callback associated with interrupt then process it..
            if (CPU.interruptQueue[i].delay < 0) { // If it is one we marked earlier delete entry or remove callback
                if (!activeFlag) {
                    CPU.interruptQueue.splice(i, 1); // No longer required - delete it
                    high--;
                    continue;
                }
                CPU.interruptQueue[i].delay = 0;
                CPU.interruptQueue[i].callback = null;
            } else { // Before calling callback mark it with a delay of -1 so we can re-find it later
                CPU.interruptQueue[i].delay = -1;
                activeFlag = CPU.interruptQueue[i].callback(CPU.interruptQueue[i].callarg); // Remember result
                high = -1; // Restart loop from the beginning.... because the callback may modify the queue
                highPriority = CPU.PIR & 0xe0;
                i = CPU.interruptQueue.length;
                continue;
            }
        }
        if (CPU.interruptQueue[i].priority > highPriority) { // Is this the new highest priority interrupr?
            highPriority = CPU.interruptQueue[i].priority & 0xe0;
            high = i;
        }
    }
    if (highPriority > (CPU.PSW & 0xe0)) { // Check if we found an interrupt to service
        if (high < 0) {
            trap(0xa0, 42); // PIR trap 240
        } else {
            trap(CPU.interruptQueue[high].vector, 44); // BR trap
            CPU.interruptQueue.splice(high, 1);
        }
    }
}


// writePSW() is used to update the CPU Processor Status Word. The PSW should generally
// be written through this routine so that changes can be tracked properly, for example
// the correct register set, the current memory management mode, etc. An exception is
// SPL which writes the priority directly. Note that that N, Z, V, and C flags are
// actually stored separately to the PSW (CPU.PSW) for performance reasons, in CPU.flagN,
// CPU.flagZ, CPU.flagV, and CPU.flagC. Also CPU.mmuMode mirrors the current processor
// mode in bits 14 & 15 of the PSW, except when being manipulated by instructions which
// work across modes (MFPD, MFPI, MTPD, MTPI, and function trap()).
//
// CPU.PSW    15 14 13 12 11 10  9  8  7  6  5  4  3  2  1  0
//              CM |  PM |RS|        |PRIORITY| T| N| Z| V| C
// mode 0 kernel 1 super 2 illegal 3 user

function writePSW(newPSW) {
    "use strict";
    var i, temp;
    CPU.flagN = newPSW << 12;
    CPU.flagZ = (~newPSW) & 4;
    CPU.flagV = newPSW << 14;
    CPU.flagC = newPSW << 16;
    if ((newPSW ^ CPU.PSW) & 0x0800) { // register set change?
        for (i = 0; i < 6; i++) {
            temp = CPU.registerVal[i];
            CPU.registerVal[i] = CPU.registerAlt[i];
            CPU.registerAlt[i] = temp; // swap the active register sets
        }
    }
    CPU.mmuMode = (newPSW >>> 14) & 3; // must always reset mmuMode
    if ((newPSW ^ CPU.PSW) & 0xc000) { // mode change?
        CPU.stackPointer[(CPU.PSW >>> 14) & 3] = CPU.registerVal[6];
        CPU.registerVal[6] = CPU.stackPointer[CPU.mmuMode]; // swap to new mode SP
    }
    if ((newPSW & 0xe0) < (CPU.PSW & 0xe0)) { // priority lowered?
        CPU.priorityReview = 1; // trigger check of priority levels
    }
    CPU.PSW = newPSW;
}


// readPSW() reassembles the  N, Z, V, and C flags back into the PSW (CPU.PSW)

function readPSW() {
    "use strict";
    CPU.PSW = (CPU.PSW & 0xf8f0) | ((CPU.flagN & 0x8000) >>> 12) | ((CPU.flagV & 0x8000) >>> 14) | ((CPU.flagC & 0x10000) >>> 16);
    if (!(CPU.flagZ & 0xffff)) {
        CPU.PSW |= 4;
    }
    return CPU.PSW;
}


// trap() handles all the trap/abort functions. It reads the trap vector from kernel
// D space, changes mode to reflect the new PSW and PC, and then pushes the old PSW and
// PC onto the new mode stack. trap() returns a -1 which is passed up through function
// calls to indicate that a trap/abort has occurred (to terminate the current instruction)
// CPU.trapPSW records the first PSW for double trap handling. The special value of -2
// allows console operations to propagate an abort without trapping to the new vector.

function trap(vector, reason) {
    "use strict";
    var newPC, newPSW, doubleTrap = 0;
    if (CPU.trapPSW > -2) { // console mode doesn't actually do all the regular trap stuff
        if (CPU.trapPSW < 0) {
            CPU.trapMask = 0; // No other traps unless we cause one here
            CPU.trapPSW = readPSW(); // Remember original PSW
        } else {
            if (!CPU.mmuMode) {
                vector = 4;
                doubleTrap = 1;
            }
        }
        //LOG_INSTRUCTION(vector, 11, "-trap-");
        if (!(CPU.MMR0 & 0xe000)) {
            CPU.MMR1 = 0xf6f6;
            CPU.MMR2 = vector;
        }
        CPU.mmuMode = 0; // read from kernel D space (mode 0)
        if ((newPC = readWordByVirtual(vector | 0x10000)) >= 0) {
            if ((newPSW = readWordByVirtual(((vector + 2) & 0xffff) | 0x10000)) >= 0) {
                writePSW((newPSW & 0xcfff) | ((CPU.trapPSW >>> 2) & 0x3000)); // set new CPU.PSW with previous mode
                if (doubleTrap) {
                    CPU.CPU_Error |= 4;
                    CPU.registerVal[6] = 4;
                }
                if (pushWord(CPU.trapPSW, doubleTrap) >= 0 && pushWord(CPU.registerVal[7], doubleTrap) >= 0) {
                    CPU.registerVal[7] = newPC;
                }
            }
        }
        CPU.trapPSW = -1; // reset flag that we have a trap within a trap
    }
    return -1; // signal that a trap has occurred
}

function readWordByPhysical(physicalAddress) {
    "use strict";
    var data;
    if (physicalAddress < IOBASE_UNIBUS) {
        data = CPU.memory[physicalAddress >>> 1];
    } else {
        data = access_iopage(physicalAddress, -1, 0);
    }
    return data;
}

function writeWordByPhysical(physicalAddress, data) {
    "use strict";
    if (physicalAddress < IOBASE_UNIBUS) {
        CPU.memory[physicalAddress >>> 1] = data;
    } else {
        return access_iopage(physicalAddress, data, 0);
    }
    return 0;
}

function readByteByPhysical(physicalAddress) {
    "use strict";
    var data;
    if (physicalAddress < IOBASE_UNIBUS) {
        if (physicalAddress & 1) {
            data = CPU.memory[physicalAddress >>> 1] >>> 8;
        } else {
            data = CPU.memory[physicalAddress >>> 1] & 0xff;
        }
    } else {
        data = access_iopage(physicalAddress, -1, 1);
    }
    return data;
}

function writeByteByPhysical(physicalAddress, data) {
    "use strict";
    var memoryIndex;
    if (physicalAddress < IOBASE_UNIBUS) {
        memoryIndex = physicalAddress >>> 1;
        if (physicalAddress & 1) {
            CPU.memory[memoryIndex] = (data << 8) | (CPU.memory[memoryIndex] & 0xff);
        } else {
            CPU.memory[memoryIndex] = (CPU.memory[memoryIndex] & 0xff00) | data;
        }
    } else {
        return access_iopage(physicalAddress, data, 1);
    }
    return 0;
}


// mapVirtualToPhysical() does memory management by converting a 17 bit I/D virtual
// address to a 22 bit physical address.
// A real PDP 11/70 memory management unit can be enabled separately for read and
// write for diagnostic purposes. This is handled here by having by having an
// enable mask (CPU.mmuEnable) which is tested against the operation access mask
// (accessMask). If there is no match then the virtual address is simply mapped
// as a 16 bit physical address with the upper page going to the IO address space.
// Access bit mask values are MMU_READ and MMU_WRITE with the lower 4 bits contaning
// the operand length; used for auto-increment calculation and to indicate byte mode
// access.
//
// As an aside it turns out that it is the memory management unit that does odd address
// and non-existent memory trapping for main memory: who knew? :-) I thought these would
// have been handled at access time similar to IO page accesses.
//
// When doing mapping CPU.mmuMode selects which address space is to be used:
// 0 = kernel, 1 = supervisor, 2 = illegal, 3 = user. Normally CPU.mmuMode is
// set by the writePSW() function but there are exceptions for instructions which
// move data between address spaces (MFPD, MFPI, MTPD, and MTPI), and function trap().
// These will modify CPU.mmuMode outside of writePSW() and then restore it again if
// all worked. If however something happens to cause a trap then no restore is done
// as writePSW() will have been invoked as part of the trap to resynchronize the
// value of CPU.mmuMode
//
// A PDP 11/70 is different to other PDP 11's in that the highest 18 bit space (017000000
// & above) map directly to unibus space - including low memory. This doesn't appear to
// be particularly useful as it restricts maximum system memory - although it does
// allow software testing of the unibus map. This feature also appears to confuse some
// OSes which test consecutive memory locations to find maximum memory - and on a full
// memory system find themselves accessing low memory again at high addresses.
//
// 15 | 14 | 13 | 12 | 11 | 10 | 9 | 8 | 7 | 6 | 5 | 4 | 3 | 2 | 1 | 0 MMR0
//nonr leng read trap unus unus ena mnt cmp  -mode- i/d  --page--   enable
//
// Map a 17 bit I/D virtual address to a 22 bit physical address

function mapVirtualToPhysical(virtualAddress, accessMask) {
    "use strict";
    var page, pdr, physicalAddress, errorMask;
    var CPU = window.CPU;
    //if (virtualAddress & ~0x1ffff) panic(89); // check VA range
    //if (!accessMask) panic(93); // Must have MMU_READ or MMU_WRITE
    CPU.displayAddress = virtualAddress & 0xffff; // Remember the 16b virtual address for display purposes
    if (!(accessMask & CPU.mmuEnable)) { // This access does not require the MMU
        physicalAddress = virtualAddress & 0xffff; // virtual address without MMU is 16 bit (no I&D)
        CPU.statusLights = 0; // Remember data light (off if no mapping)
        if (physicalAddress >= IOBASE_VIRT) {
            physicalAddress |= IOBASE_22BIT;
        } else { // no max_memory check in 16 bit mode
            if ((physicalAddress & 1) && !(accessMask & MMU_BYTE_MODE)) { // odd address check
                CPU.statusLights |= 0x400; // Set ADRS ERR light
                CPU.CPU_Error |= 0x40;
                return trap(4, 22);
            }
        }
    } else { // This access is mapped by the MMU
        page = ((virtualAddress >>> 13) & CPU.MMR3Mask[CPU.mmuMode]) | (CPU.mmuMode << 4); // Determine PDR/PAR page index using mode and I&D
        physicalAddress = ((CPU.mmuPAR[page] << 6) + (virtualAddress & 0x1fff)) & 0x3fffff;
        CPU.statusLights = page & 8; // Remember data light
        if (!(CPU.MMR3 & 0x10)) { // 18 bit mapping needs extra trimming
            physicalAddress &= 0x3ffff;
            if (physicalAddress >= IOBASE_18BIT) {
                physicalAddress |= IOBASE_22BIT;
            }
        }
        if (physicalAddress < MAX_MEMORY) { // Ordinary memory space only needs an odd address check
            if ((physicalAddress & 1) && !(accessMask & MMU_BYTE_MODE)) {
                CPU.statusLights |= 0x400; // Set ADRS ERR light
                CPU.CPU_Error |= 0x40;
                return trap(4, 26);
            }
            CPU.mmuLastPage = page;
        } else { // Higher addresses may require unibus mapping and a check if non-existent
            if (physicalAddress < IOBASE_22BIT) {
                if (physicalAddress >= IOBASE_UNIBUS) {
                    physicalAddress = mapUnibus(physicalAddress & 0x3ffff); // 18bit unibus space
                    if (physicalAddress >= MAX_MEMORY && physicalAddress < IOBASE_22BIT) {
                        CPU.statusLights |= 0x400; // Set ADRS ERR light
                        CPU.CPU_Error |= 0x10; // Unibus timeout
                        return trap(4, 24); // KB11-EM does this after ABORT handling - KB11-CM before
                    }
                } else {
                    CPU.statusLights |= 0x400; // Set ADRS ERR light
                    CPU.CPU_Error |= 0x20; // Non-existent main memory
                    return trap(4, 24);
                }
            }
            if ((physicalAddress != 0x3fff7a) || CPU.mmuMode) { // MMR0 is 017777572 and doesn't affect MMR0 bits
                CPU.mmuLastPage = page;
            }
        }
        errorMask = 0;
        pdr = CPU.mmuPDR[page];
        switch (pdr & 0x7) { // Check the Access Control Field (ACF) - really a page type
            case 1: // read-only with trap
                errorMask = 0x1000; // MMU trap - then fall thru
            case 2: // read-only
                CPU.mmuPDR[page] = pdr | 0x80; // Set A bit
                if (accessMask & MMU_WRITE) {
                    errorMask = 0x2000; // read-only abort
                }
                break;
            case 4: // read-write with read-write trap
                errorMask = 0x1000; // MMU trap - then fall thru
            case 5: // read-write with write trap
                if (accessMask & MMU_WRITE) {
                    errorMask = 0x1000; // MMU trap - then fall thru
                }
                case 6: // read-write
                    CPU.mmuPDR[page] = pdr | ((accessMask & MMU_WRITE) ? 0xc0 : 0x80); // Set A & W bits
                    break;
                default:
                    errorMask = 0x8000; // non-resident abort
                    break;
        }
        if ((pdr & 0x7f08) != 0x7f00) { // Skip page length check for full page expand upwards
            if (pdr & 0x8) { // Page expands downwards
                if ((virtualAddress & 0x1fc0) < ((pdr >>> 2) & 0x1fc0)) {
                    errorMask |= 0x4000; // page length error abort
                }
            } else { // Page expand upwards
                if ((virtualAddress & 0x1fc0) > ((pdr >>> 2) & 0x1fc0)) {
                    errorMask |= 0x4000; // page length error abort
                }
            }
        }
        // aborts and traps: log FIRST trap and MOST RECENT abort
        if (errorMask) {
            if (errorMask & 0xe000) {
                if (CPU.trapPSW >= 0) {
                    errorMask |= 0x80; // Instruction complete
                }
                if (!(CPU.MMR0 & 0xe000)) {
                    CPU.MMR0 |= errorMask | (CPU.mmuLastPage << 1);
                }
                CPU.statusLights |= 0x400; // Set ADRS ERR light
                return trap(0xa8, 28); // 0250
            }
            if (!(CPU.MMR0 & 0xf000)) {
                if (physicalAddress < 0x3ff480 || physicalAddress > 0x3fffbf) { // 017772200 - 017777677
                    CPU.MMR0 |= 0x1000; // MMU trap flag
                    if (CPU.MMR0 & 0x0200) {
                        CPU.trapMask |= 2; // MMU trap
                    }
                }
            }
        }
    }
    return (CPU.displayPhysical = physicalAddress);
}

function readWordByVirtual(virtualAddress) { // input address is 17 bit (I&D)
    "use strict";
    var physicalAddress;
    if ((physicalAddress = mapVirtualToPhysical(virtualAddress, MMU_WORD_READ)) < 0) {
        return physicalAddress;
    }
    return readWordByPhysical(physicalAddress);
}

function writeWordByVirtual(virtualAddress, data) { // input address is 17 bit (I&D)
    "use strict";
    var physicalAddress;
    if ((physicalAddress = mapVirtualToPhysical(virtualAddress, MMU_WORD_WRITE)) < 0) {
        return physicalAddress;
    }
    return writeWordByPhysical(physicalAddress, data);
}

// Stack limit checks only occur for Kernel mode and are either a yellow warning trap
// after instruction completion, or a red abort which stops the current instruction.

function stackCheck(virtualAddress) {
    "use strict";
    if (!CPU.mmuMode) { // Kernel mode 0 checking only
        if (virtualAddress <= CPU.stackLimit || virtualAddress >= 0xfffe) {
            if (virtualAddress + 32 <= CPU.stackLimit || virtualAddress >= 0xfffe) {
                CPU.statusLights |= 0x400; // Set ADRS ERR light
                CPU.CPU_Error |= 4; // Red stack
                CPU.registerVal[6] = 4;
                return trap(4, 38);
            }
            CPU.CPU_Error |= 8; // Yellow
            CPU.trapMask |= 4;
        }
    }
    return virtualAddress;
}

function pushWord(data, skipLimitCheck) {
    "use strict";
    var virtualAddress;
    virtualAddress = CPU.registerVal[6] = (CPU.registerVal[6] - 2) & 0xffff; // BSD meeds SP updated before any fault :-(
    if (!(CPU.MMR0 & 0xe000)) {
        CPU.MMR1 = (CPU.MMR1 << 8) | 0xf6;
    }
    if (!skipLimitCheck) {
        if ((virtualAddress = stackCheck(virtualAddress)) < 0) {
            return virtualAddress;
        }
    }
    return writeWordByVirtual(virtualAddress | 0x10000, data);
}

function popWord() {
    "use strict";
    var data;
    if ((data = readWordByVirtual(CPU.registerVal[6] | 0x10000)) >= 0) {
        CPU.registerVal[6] = (CPU.registerVal[6] + 2) & 0xffff;
    }
    return data;
}


// getVirtualByMode() maps a six bit instruction operand to a 17 bit I/D virtual
// address space. Instruction operands are six bits in length - three bits for the
// mode and three for the register. The 17th I/D bit in the resulting virtual
// address represents whether the reference is to Instruction space or Data space,
// which depends on the combination of the operand mode and whether the register is
// the Program Counter (register 7).
//
// The eight instruction addressing modes are:-
//      0   R           no valid virtual address (error)
//      1   (R)         operand from I/D depending if R = 7
//      2   (R)+        operand from I/D depending if R = 7
//      3   @(R)+       address from I/D depending if R = 7 and operand is from D space
//      4   -(R)        operand from I/D depending if R = 7
//      5   @-(R)       address from I/D depending if R = 7 and operand is from D space
//      6   x(R)        x from I space but operand from D space
//      7   @x(R)       x from I space but address and operand from D space
//
// Kernel mode stack limit checks are implemented for addressing modes 1, 2, 4 & 6 (!)
//
// The accessMode field specifies two bit flags for read or write, or both for a modify.
// Mask values for these are constants MMU_READ and MMU_WRITE which are used by the MMU
// to indicate the data access type (determines whether page access is allowed, whether to
// mark the page as modified, etc).
// In addition the lower four bits specify the operand length. This is 1 for a byte
// or 2 for a word - however the FPP processor may also use lengths of 4 or 8. Thus if
// autoincrement is used for an FPP double word the register will autoincrement by 8.
// The length component is always required here for autoincrement/decrement, but the
// MMU_READ and MMU_WRITE flags are not required if no operand access is intended
// (eg getting the destination address for a JSR instruction jump or locating the virtual
// address of a FPP operand).
//
// Just to keep us on our toes the mode (PC)+ (immediate mode, octal 27) ALWAYS increments
// by 2 no matter what type of operand is used!!
//
// Also CPU.MMR1 must be updated to track which registers have been incremented and
// decremented. This allows software to backout any changes and restart an instruction
// when a page fault occurs.
//
// Convert a six bit instruction operand to a 17 bit I/D virtual address

function getVirtualByMode(addressMode, accessMode) {
    "use strict";
    var virtualAddress, autoIncrement, reg = addressMode & 7;
    switch ((addressMode >>> 3) & 7) {
        case 0: // Mode 0: Registers don't have a virtual address so trap!
            return trap(4, 34);
        case 1: // Mode 1: (R)
            virtualAddress = CPU.registerVal[reg];
            if (reg < 7) {
                if (reg == 6) {
                    if (accessMode & MMU_WRITE) {
                        if ((virtualAddress = stackCheck(virtualAddress)) < 0) {
                            return virtualAddress;
                        }
                    }
                }
                virtualAddress |= 0x10000; // Use D space if not R7
            }
            return virtualAddress;
        case 2: // Mode 2: (R)+ including immediate operand #x
            autoIncrement = accessMode & MMU_LENGTH_MASK;
            virtualAddress = CPU.registerVal[reg];
            if (reg < 6) {
                virtualAddress |= 0x10000; // Use D space
            } else {
                if (reg == 6) {
                    if (accessMode & MMU_BYTE_MODE) {
                        autoIncrement = 2; // R6 doesn't autoIncrement by 1
                    }
                    if (accessMode & MMU_WRITE) {
                        if ((virtualAddress = stackCheck(virtualAddress)) < 0) {
                            return virtualAddress;
                        }
                    }
                    virtualAddress |= 0x10000; // Use D space for (SP)+
                } else {
                    autoIncrement = 2; // R7 always increments by 2
                }
            }
            break;
        case 3: // Mode 3: @(R)+
            autoIncrement = 2;
            virtualAddress = CPU.registerVal[reg];
            if (reg != 7) {
                virtualAddress |= 0x10000; // Use D space if not R7
            }
            if ((virtualAddress = readWordByVirtual(virtualAddress)) < 0) {
                return virtualAddress;
            }
            virtualAddress |= 0x10000; // Use D space
            break;
        case 4: // Mode 4: -(R)
            autoIncrement = -(accessMode & MMU_LENGTH_MASK);
            if (reg < 6) {
                virtualAddress = ((CPU.registerVal[reg] + autoIncrement) & 0xffff) | 0x10000;
            } else {
                if ((accessMode & MMU_BYTE_MODE) || reg == 7) {
                    autoIncrement = -2;
                }
                virtualAddress = (CPU.registerVal[reg] + autoIncrement) & 0xffff;
                if (reg == 6) {
                    if (accessMode & MMU_WRITE) {
                        if ((virtualAddress = stackCheck(virtualAddress)) < 0) {
                            return virtualAddress;
                        }
                    }
                    virtualAddress |= 0x10000; // Use D space for -(SP)
                }
            }
            break;
        case 5: // Mode 5: @-(R)
            autoIncrement = -2;
            virtualAddress = (CPU.registerVal[reg] - 2) & 0xffff;
            if (reg != 7) {
                virtualAddress |= 0x10000; // Use D space if not R7
            }
            if ((virtualAddress = readWordByVirtual(virtualAddress)) < 0) {
                return virtualAddress;
            }
            virtualAddress |= 0x10000; // Use D space
            break;
        case 6: // Mode 6: d(R)
            if ((virtualAddress = readWordByVirtual(CPU.registerVal[7])) < 0) {
                return virtualAddress;
            }
            CPU.registerVal[7] = (CPU.registerVal[7] + 2) & 0xffff;
            virtualAddress = (virtualAddress + CPU.registerVal[reg]) & 0xffff;
            if (reg == 6 && (accessMode & MMU_WRITE)) {
                if ((virtualAddress = stackCheck(virtualAddress)) < 0) {
                    return virtualAddress;
                }
            }
            return virtualAddress | 0x10000;
        case 7: // Mode 7: @d(R)
            if ((virtualAddress = readWordByVirtual(CPU.registerVal[7])) < 0) {
                return virtualAddress;
            }
            CPU.registerVal[7] = (CPU.registerVal[7] + 2) & 0xffff;
            virtualAddress = (virtualAddress + CPU.registerVal[reg]) & 0xffff;
            if ((virtualAddress = readWordByVirtual(virtualAddress | 0x10000)) < 0) {
                return virtualAddress;
            }
            return virtualAddress | 0x10000; // @x
    }
    CPU.registerVal[reg] = (CPU.registerVal[reg] + autoIncrement) & 0xffff;
    if (!(CPU.MMR0 & 0xe000)) {
        CPU.MMR1 = (CPU.MMR1 << 8) | ((autoIncrement << 3) & 0xf8) | reg;
    }
    return virtualAddress;
}


// Convert an instruction operand into a 17 bit I/D virtual address and then into a
// 22 bit physical address.
// Note: attempting to get the physical address of a register is an error!

function mapPhysicalByMode(addressMode, accessMode) {
    "use strict";
    var virtualAddress;
    if ((virtualAddress = getVirtualByMode(addressMode, accessMode)) < 0) {
        return virtualAddress;
    }
    return mapVirtualToPhysical(virtualAddress, accessMode);
}

function readWordByMode(addressMode) {
    "use strict";
    var data, physicalAddress;
    if (!(addressMode & 0x38)) { // If register mode just get register value
        data = CPU.registerVal[addressMode & 7];
    } else {
        if ((physicalAddress = mapPhysicalByMode(addressMode, MMU_WORD_READ)) < 0) {
            return physicalAddress;
        }
        data = readWordByPhysical(physicalAddress);
    }
    return data;
}

function writeWordByMode(addressMode, data) {
    "use strict";
    data &= 0xffff;
    var physicalAddress;
    if (!(addressMode & 0x38)) { // If register mode write to the register 
        CPU.registerVal[addressMode & 7] = data;
    } else {
        if ((physicalAddress = mapPhysicalByMode(addressMode, MMU_WORD_WRITE)) < 0) {
            return physicalAddress;
        }
        return writeWordByPhysical(physicalAddress, data);
    }
    return 0;
}

function modifyWordByMode(addressMode) {
    "use strict";
    var data, physicalAddress;
    if (!(addressMode & 0x38)) { // If register mode get register value and remember which register
        CPU.modifyRegister = addressMode & 7;
        data = CPU.registerVal[CPU.modifyRegister];
    } else {
        if ((physicalAddress = mapPhysicalByMode(addressMode, MMU_WORD_MODIFY)) < 0) {
            return physicalAddress;
        }
        CPU.modifyRegister = -1;
        CPU.modifyAddress = physicalAddress; // Remember physical address for modify
        data = readWordByPhysical(physicalAddress);
    }
    return data;
}

function modifyWord(data) {
    "use strict";
    data &= 0xffff;
    if (CPU.modifyRegister >= 0) { // Modify the last register or memory address accessed
        CPU.registerVal[CPU.modifyRegister] = data;
    } else {
        return writeWordByPhysical(CPU.modifyAddress, data);
    }
    return 0;
}

function readByteByMode(addressMode) {
    "use strict";
    var data, physicalAddress;
    if (!(addressMode & 0x38)) { // If register mode just get register value
        data = CPU.registerVal[addressMode & 7] & 0xff;
    } else {
        if ((physicalAddress = mapPhysicalByMode(addressMode, MMU_BYTE_READ)) < 0) {
            return physicalAddress;
        }
        data = readByteByPhysical(physicalAddress);
    }
    return data;
}

function writeByteByMode(addressMode, data) {
    "use strict";
    var physicalAddress;
    data &= 0xff;
    if (!(addressMode & 0x38)) { // If register mode write to the register 
        CPU.registerVal[addressMode & 7] = (CPU.registerVal[addressMode & 7] & 0xff00) | data;
    } else {
        if ((physicalAddress = mapPhysicalByMode(addressMode, MMU_BYTE_WRITE)) < 0) {
            return physicalAddress;
        }
        return writeByteByPhysical(physicalAddress, data);
    }
    return 0;
}

function modifyByteByMode(addressMode) {
    "use strict";
    var data, physicalAddress;
    if (!(addressMode & 0x38)) { // If register mode get register value and remember which register
        CPU.modifyRegister = addressMode & 7;
        data = CPU.registerVal[CPU.modifyRegister] & 0xff;
    } else {
        if ((physicalAddress = mapPhysicalByMode(addressMode, MMU_BYTE_MODIFY)) < 0) {
            return physicalAddress;
        }
        CPU.modifyRegister = -1;
        CPU.modifyAddress = physicalAddress; // Remember physical address for modify
        data = readByteByPhysical(physicalAddress);
    }
    return data;
}

function modifyByte(data) {
    "use strict";
    data &= 0xff;
    if (CPU.modifyRegister >= 0) { // Modify the last register or memory address accessed
        CPU.registerVal[CPU.modifyRegister] = (CPU.registerVal[CPU.modifyRegister] & 0xff00) | data;
    } else {
        return writeByteByPhysical(CPU.modifyAddress, data);
    }
    return 0;
}

// branch() calculates the branch to PC from a branch instruction offset

function branch(PC, instruction) {
    "use strict";
    return (PC + ((instruction & 0x80 ? instruction | 0xff00 : instruction & 0xff) << 1)) & 0xffff;
}


// Most instruction read operations use a 6 bit instruction operand via
// the a ByMode function such as readWordByMode(). A negative function
// return indicates that something has failed and a trap or abort has
// been invoked. The coding template would be:
//
//   if ((src = readWordByMode(instruction >>> 6)) >= 0) {
//         success - use the src value
//
// Likewise write operations use function writeWordByMode() to write a
// result to a register or memory and return a negative value if a failure
// occurs (non-existant memory, page fault, non-existant device, etc).
// In this case further instrucion processing should be aborted. The
// coding template is:
//
//    if (writeWordByMode(instruction, data) >= 0) {
//         continue the instruction
//
// For each Word function there are generally corresponding Byte functions,
// eg readByteByMode() - however there are no byte functions for accessing
// bytes by virtual address as they are not required.
//
// Read/Write operations require two functions to retrieve and then update
// the value. The first function requests memory mapping with modify access,
// stores the register number or address for the second function, and then
// returns the operand. The second function simply writes the updated value
// back to the remembered location. If either function returns a negative
// value then an error condition has been encountered. The coding template
// is:
//
//    if ((dst = modifyByteByMode(instruction)) >= 0) {
//          result = some computation on dst
//          if (modifyByte(result) >= 0) {
//               continue processing
//
// Some instructions (eg JMP, JSR, MTPx..) require the address of an operand.
// The code for this would generally look like:
//
//   if ((virtualAddress = getVirtualByMode(instruction, MMU_WORD)) >= 0) {
//        do something with the address
//
// Note that in this case there is an access mode to specify the operand length
// (required for auto incremenet/decrement) but not an access type (MMU_READ or
// MMU_WRITE) as the mapping does not attempt to access the operand.
//
// CPU flags are stored outside of the PSW for performance reasons. A call to
// readPSW() will assemble them back into the PSW. Writes to the PSW should generally
// be through writePSW() as it needs to track which register set is in use, the memory
// management mode, whether priority has changed etc.
// Individual flags are CPU.flagC, CPU.flagN, CPU.flagV, and CPU.flagZ. These hold
// the value of the last result affecting them. So for example bit 16 of CPU.flagC
// is the only useful bit it contains. Likewise bit 15 of CPU.flagN and CPU.flagV are
// the only bit they use. For CPU.flagZ the lower 16 bits must be tested to see if
// the result was zero or not.
// Similarly CPU.mmuMode mirrors the current processor mode held in bits
// 14 & 15 of the PSW - as it is frequently used by memory management operations.
//
// All traps and aborts go through the trap() function. It returns a -1 value which
// is then passed up through other function layers and interpreted as an indicator
// that something has gone wrong, and that no futher processing is to be done for the
// current instruction.
//
// Instruction execution is performed by the emulate() function which processes a
// batch of instructions. The current strategy is to execute 1000 instructions
// repeating until 10 milliseconds have passed.
//
// Batching instructions in this way is required in Javascript as it is necessary
// to relinquish control periodically to let timer and I/O functions execute, and to
// update the console lights. Of course if JavaScript had a method for testing whether
// an event was pending then we could have structured things very differently...


function emulate(loopCount) {
    "use strict";
    var instruction,
        src,
        dst,
        result = 0, // used for light data
        virtualAddress, savePSW, reg;
    var loopTime = Date.now() + 8;
    var CPU = window.CPU;
    if (CPU.runState != STATE_RUN) {
        return;
    }
    do {
        // If something has changed review priority - with a one instruction delay after SPL (!)
        if (CPU.priorityReview) {
            if (!(--CPU.priorityReview)) {
                interruptReview();
            }
        }
        // Check if previous instruction has outstanding post instruction traps
        if (CPU.trapMask) {
            if (CPU.trapMask & 2) {
                trap(0o250, 52); // MMU trap 250 has priority
            } else {
                if (CPU.trapMask & 4) {
                    trap(0o4, 54); // then stack warning trap
                } else {
                    if (CPU.trapMask & 8) {
                        trap(0o244, 55); // then FPP floating point exception
                    } else {
                        if (CPU.trapMask & 0x10) { // same bit as T bit trap in PSW
                            trap(0o14, 56); // and finally a T-bit trap
                        }
                    }
                }
            }
        }
        // At start of instruction cycle set MMR state unless it is frozen
        if (!(CPU.MMR0 & 0xe000)) {
            CPU.MMR1 = 0;
            CPU.MMR2 = CPU.registerVal[7];
        }
        // Remember if T-bit trap required at the end of this instruction
        CPU.trapMask = CPU.PSW & 0x10;
        if ((instruction = readWordByVirtual(CPU.registerVal[7])) >= 0) {
            //if (CPU.registerVal[7] == 002034) { // DDEEBBUUGG
            //  console.log("PC " + CPU.registerVal[7].toString(8) + " instruction: " + instruction.toString(8) + " R0: " + CPU.registerVal[0].toString(8) + " R4: " + CPU.registerVal[4].toString(8));
            //}
            CPU.registerVal[7] = (CPU.registerVal[7] + 2) & 0xffff;
            switch (instruction & 0o170000) { // Double operand instructions xxSSDD
                case 0o010000: // MOV  01SSDD
                    //LOG_INSTRUCTION(instruction, 2, "MOV");
                    if ((result = readWordByMode(instruction >>> 6)) >= 0) {
                        if (writeWordByMode(instruction, result) >= 0) {
                            CPU.flagN = CPU.flagZ = result;
                            CPU.flagV = 0;
                        }
                    }
                    break;
                case 0o020000: // CMP 02SSDD
                    //LOG_INSTRUCTION(instruction, 2, "CMP");
                    if ((src = readWordByMode(instruction >>> 6)) >= 0) {
                        if ((dst = readWordByMode(instruction)) >= 0) {
                            result = src - dst;
                            CPU.flagN = CPU.flagZ = CPU.flagC = result;
                            CPU.flagV = (src ^ dst) & (src ^ result);
                        }
                    }
                    break;
                case 0o030000: // BIT 03SSDD
                    //LOG_INSTRUCTION(instruction, 2, "BIT");
                    if ((src = readWordByMode(instruction >>> 6)) >= 0) {
                        if ((result = readWordByMode(instruction)) >= 0) {
                            CPU.flagN = CPU.flagZ = src & result;
                            CPU.flagV = 0;
                        }
                    }
                    break;
                case 0o040000: // BIC 04SSDD
                    //LOG_INSTRUCTION(instruction, 2, "BIC");
                    if ((src = readWordByMode(instruction >>> 6)) >= 0) {
                        if ((dst = modifyWordByMode(instruction)) >= 0) {
                            result = dst & ~src;
                            if (modifyWord(result) >= 0) {
                                CPU.flagN = CPU.flagZ = result;
                                CPU.flagV = 0;
                            }
                        }
                    }
                    break;
                case 0o050000: // BIS 05SSDD
                    //LOG_INSTRUCTION(instruction, 2, "BIS");
                    if ((src = readWordByMode(instruction >>> 6)) >= 0) {
                        if ((dst = modifyWordByMode(instruction)) >= 0) {
                            result = dst | src;
                            if (modifyWord(result) >= 0) {
                                CPU.flagN = CPU.flagZ = result;
                                CPU.flagV = 0;
                            }
                        }
                    }
                    break;
                case 0o060000: // ADD 06SSDD
                    //LOG_INSTRUCTION(instruction, 2, "ADD");
                    if ((src = readWordByMode(instruction >>> 6)) >= 0) {
                        if ((dst = modifyWordByMode(instruction)) >= 0) {
                            result = src + dst;
                            if (modifyWord(result) >= 0) {
                                CPU.flagN = CPU.flagZ = CPU.flagC = result;
                                CPU.flagV = (src ^ result) & (dst ^ result);
                            }
                        }
                    }
                    break;
                case 0o110000: // MOVB 11SSDD
                    //LOG_INSTRUCTION(instruction, 2, "MOVB");
                    if ((result = readByteByMode(instruction >>> 6)) >= 0) {
                        if (!(instruction & 0x38)) { // Need sign extension when writing to a register
                            if (result & 0o200) {
                                result |= 0xff00; // Special case: movb sign extends register to word size
                            }
                            CPU.registerVal[instruction & 7] = result;
                            CPU.flagN = CPU.flagZ = result;
                            CPU.flagV = 0;
                        } else {
                            if (writeByteByMode(instruction, result) >= 0) {
                                CPU.flagN = CPU.flagZ = result << 8;
                                CPU.flagV = 0;
                            }
                        }
                    }
                    break;
                case 0o120000: // CMPB 12SSDD
                    //LOG_INSTRUCTION(instruction, 2, "CMPB");
                    if ((src = readByteByMode(instruction >>> 6)) >= 0) {
                        if ((dst = readByteByMode(instruction)) >= 0) {
                            result = src - dst;
                            CPU.flagN = CPU.flagZ = CPU.flagC = result << 8;
                            CPU.flagV = ((src ^ dst) & (src ^ result)) << 8;
                        }
                    }
                    break;
                case 0o130000: // BITB 13SSDD
                    //LOG_INSTRUCTION(instruction, 2, "BITB");
                    if ((src = readByteByMode(instruction >>> 6)) >= 0) {
                        if ((result = readByteByMode(instruction)) >= 0) {
                            CPU.flagN = CPU.flagZ = (src & result) << 8;
                            CPU.flagV = 0;
                        }
                    }
                    break;
                case 0o140000: // BICB 14SSDD
                    //LOG_INSTRUCTION(instruction, 2, "BICB");
                    if ((src = readByteByMode(instruction >>> 6)) >= 0) {
                        if ((dst = modifyByteByMode(instruction)) >= 0) {
                            result = dst & ~src;
                            if (modifyByte(result) >= 0) {
                                CPU.flagN = CPU.flagZ = result << 8;
                                CPU.flagV = 0;
                            }
                        }
                    }
                    break;
                case 0o150000: // BISB 15SSDD
                    //LOG_INSTRUCTION(instruction, 2, "BISB");
                    if ((src = readByteByMode(instruction >>> 6)) >= 0) {
                        if ((dst = modifyByteByMode(instruction)) >= 0) {
                            result = dst | src;
                            if (modifyByte(result) >= 0) {
                                CPU.flagN = CPU.flagZ = result << 8;
                                CPU.flagV = 0;
                            }
                        }
                    }
                    break;
                case 0o160000: // SUB 16SSDD
                    //LOG_INSTRUCTION(instruction, 2, "SUB");
                    if ((src = readWordByMode(instruction >>> 6)) >= 0) {
                        if ((dst = modifyWordByMode(instruction)) >= 0) {
                            result = dst - src;
                            if (modifyWord(result) >= 0) {
                                CPU.flagN = CPU.flagZ = CPU.flagC = result;
                                CPU.flagV = (src ^ dst) & (dst ^ result);
                            }
                        }
                    }
                    break;
                case 0o170000: // FPP instructions
                    if (typeof executeFPP !== 'undefined') {
                        executeFPP(instruction);
                    } else { // Say we don't know this instruction
                        //LOG_INSTRUCTION(instruction, 11, "-unknown-");
                        trap(0o10, 48); // Trap 10 - Illegal instruction
                    }
                    break;
                default:
                    switch (instruction & 0o177000) { // Misc instructions xxRDD
                        case 0o4000: // JSR 004RDD
                            //LOG_INSTRUCTION(instruction, 3, "JSR");
                            if ((virtualAddress = getVirtualByMode(instruction, MMU_WORD)) >= 0) {
                                reg = (instruction >>> 6) & 7;
                                if (pushWord(CPU.registerVal[reg], 0) >= 0) {
                                    CPU.registerVal[reg] = CPU.registerVal[7];
                                    CPU.registerVal[7] = virtualAddress & 0xffff;
                                }
                            }
                            break;
                        case 0o070000: // MUL 070RSS
                            //LOG_INSTRUCTION(instruction, 3, "MUL");
                            if ((src = readWordByMode(instruction)) >= 0) {
                                reg = (instruction >>> 6) & 7;
                                dst = CPU.registerVal[reg];
                                if (src & 0x8000) {
                                    src -= 0x10000;
                                }
                                if (dst & 0x8000) {
                                    dst -= 0x10000;
                                }
                                result = src * dst;
                                CPU.registerVal[reg] = (result >>> 16) & 0xffff;
                                CPU.registerVal[reg | 1] = result & 0xffff;
                                CPU.flagN = result >>> 16;
                                CPU.flagZ = CPU.flagN | result;
                                CPU.flagC = CPU.flagV = 0;
                                if (result < -32768 || result > 32767) {
                                    CPU.flagC = 0x10000;
                                }
                            }
                            break;
                        case 0o071000: // DIV 071RSS
                            //LOG_INSTRUCTION(instruction, 3, "DIV");
                            if ((src = readWordByMode(instruction)) >= 0) {
                                if (!src) { // divide by zero
                                    CPU.flagN = CPU.flagZ = 0;
                                    CPU.flagV = 0x8000;
                                    CPU.flagC = 0x10000;
                                } else {
                                    reg = (instruction >>> 6) & 7;
                                    dst = (CPU.registerVal[reg] << 16) | CPU.registerVal[reg | 1];
                                    if (src & 0x8000) {
                                        src -= 0x10000;
                                    }
                                    if (dst & 0x80000000) {
                                        dst = (dst & 0x7fffffff) - 0x80000000;
                                    }
                                    CPU.flagC = CPU.flagV = 0;
                                    result = ~~(dst / src);
                                    if (result >= -32768 && result <= 32767) {
                                        CPU.registerVal[reg] = result & 0xffff;
                                        CPU.registerVal[reg | 1] = (dst - (result * src)) & 0xffff;
                                        CPU.flagZ = (result >>> 16) | result;
                                        CPU.flagN = result >>> 16;
                                    } else {
                                        CPU.flagV = 0x8000; // overflow - following are indeterminate
                                        CPU.flagZ = (result >>> 15) | result; // dodgy
                                        CPU.flagN = dst >>> 16; // just as dodgy
                                        if (src == -1 && CPU.registerVal[reg] == 0xfffe) {
                                            CPU.registerVal[reg] = CPU.registerVal[reg | 1] = 1; // etc
                                        }
                                    }
                                }
                            }
                            break;
                        case 0o72000: // ASH 072RSS
                            //LOG_INSTRUCTION(instruction, 3, "ASH");
                            if ((src = readWordByMode(instruction)) >= 0) {
                                reg = (instruction >>> 6) & 7;
                                result = CPU.registerVal[reg];
                                CPU.flagC = CPU.flagV = 0;
                                src &= 0x3f;
                                if (src) {
                                    if (src & 0x20) { // if shift right (1-32)
                                        dst = result;
                                        result >>= (63 - src);
                                        CPU.flagC = result << 16;
                                        result >>= 1;
                                        if (dst & 0x8000) {
                                            if (src < 49) {
                                                src = 49;
                                            }
                                            result |= 0xffffffff << (src - 49);
                                        }
                                    } else { // shift left (1-31)
                                        dst = result << 16;
                                        dst >>>= (31 - src); // EQKC confirms ANY change of sign during shift sets V :-(
                                        if (dst && dst != (0xffff0000 >>> (31 - src))) {
                                            CPU.flagV = 0x8000;
                                        }
                                        result <<= src;
                                        CPU.flagC = result;
                                    }
                                }
                                CPU.registerVal[reg] = result & 0xffff;
                                CPU.flagN = CPU.flagZ = result;
                            }
                            break;
                        case 0o73000: // ASHC 073RSS
                            //LOG_INSTRUCTION(instruction, 3, "ASHC");
                            if ((src = readWordByMode(instruction)) >= 0) {
                                reg = (instruction >>> 6) & 7;
                                result = (CPU.registerVal[reg] << 16) | CPU.registerVal[reg | 1];
                                CPU.flagC = CPU.flagV = 0;
                                src &= 0x3f;
                                if (src) {
                                    if (src & 0x20) { // if shift right (1-32)
                                        dst = result;
                                        result >>= (63 - src);
                                        CPU.flagC = result << 16;
                                        result >>= 1;
                                        if (dst & 0x80000000) {
                                            if (src < 33) {
                                                src = 33;
                                            }
                                            result |= 0xffffffff << (src - 33);
                                        }
                                    } else { // shift left (1-31)
                                        dst = result >>> (31 - src); // EQKC confirms ANY change of sign during shift sets V :-(
                                        if (dst && dst != (0xffffffff >>> (31 - src))) {
                                            CPU.flagV = 0x8000;
                                        }
                                        result <<= (src - 1);
                                        CPU.flagC = result >>> 15;
                                        result <<= 1;
                                    }
                                }
                                CPU.registerVal[reg] = (result >>> 16) & 0xffff;
                                CPU.registerVal[reg | 1] = result & 0xffff;
                                CPU.flagN = result >>> 16;
                                CPU.flagZ = CPU.flagN | result;
                            }
                            break;
                        case 0o074000: // XOR 074RSS
                            //LOG_INSTRUCTION(instruction, 3, "XOR");
                            src = CPU.registerVal[(instruction >>> 6) & 7];
                            if ((result = modifyWordByMode(instruction)) >= 0) {
                                result ^= src;
                                if (modifyWord(result) >= 0) {
                                    CPU.flagN = CPU.flagZ = result;
                                    CPU.flagV = 0;
                                }
                            }
                            break;
                        case 0o077000: // SOB 077Rnn
                            //LOG_INSTRUCTION(instruction, 5, "SOB");
                            reg = (instruction >>> 6) & 7;
                            if ((CPU.registerVal[reg] = ((CPU.registerVal[reg] - 1) & 0xffff))) {
                                CPU.registerVal[7] = (CPU.registerVal[7] - ((instruction & 0o77) << 1)) & 0xffff;
                            }
                            break;
                        default:
                            switch (instruction & 0o177400) { // Program control instructions & traps
                                case 0o000400: // BR
                                    //LOG_INSTRUCTION(instruction, 4, "BR");
                                    CPU.registerVal[7] = branch(CPU.registerVal[7], instruction);
                                    break;
                                case 0o001000: // BNE
                                    //LOG_INSTRUCTION(instruction, 4, "BNE");
                                    if (CPU.flagZ & 0xffff) {
                                        CPU.registerVal[7] = branch(CPU.registerVal[7], instruction);
                                    }
                                    break;
                                case 0o001400: // BEQ
                                    //LOG_INSTRUCTION(instruction, 4, "BEQ");
                                    if (!(CPU.flagZ & 0xffff)) {
                                        CPU.registerVal[7] = branch(CPU.registerVal[7], instruction);
                                    }
                                    break;
                                case 0o002000: // BGE
                                    //LOG_INSTRUCTION(instruction, 4, "BGE");
                                    if ((CPU.flagN & 0x8000) == (CPU.flagV & 0x8000)) {
                                        CPU.registerVal[7] = branch(CPU.registerVal[7], instruction);
                                    }
                                    break;
                                case 0o002400: // BLT
                                    //LOG_INSTRUCTION(instruction, 4, "BLT");
                                    if ((CPU.flagN & 0x8000) != (CPU.flagV & 0x8000)) {
                                        CPU.registerVal[7] = branch(CPU.registerVal[7], instruction);
                                    }
                                    break;
                                case 0o003000: // BGT
                                    //LOG_INSTRUCTION(instruction, 4, "BGT");
                                    if ((CPU.flagZ & 0xffff) && ((CPU.flagN & 0x8000) == (CPU.flagV & 0x8000))) {
                                        CPU.registerVal[7] = branch(CPU.registerVal[7], instruction);
                                    }
                                    break;
                                case 0o003400: // BLE
                                    //LOG_INSTRUCTION(instruction, 4, "BLE");
                                    if (!(CPU.flagZ & 0xffff) || ((CPU.flagN & 0x8000) != (CPU.flagV & 0x8000))) {
                                        CPU.registerVal[7] = branch(CPU.registerVal[7], instruction);
                                    }
                                    break;
                                case 0o100000: // BPL
                                    //LOG_INSTRUCTION(instruction, 4, "BPL");
                                    if (!(CPU.flagN & 0x8000)) {
                                        CPU.registerVal[7] = branch(CPU.registerVal[7], instruction);
                                    }
                                    break;
                                case 0o101000: // BHI
                                    //LOG_INSTRUCTION(instruction, 4, "BHI");
                                    if (!(CPU.flagC & 0x10000) && (CPU.flagZ & 0xffff)) {
                                        CPU.registerVal[7] = branch(CPU.registerVal[7], instruction);
                                    }
                                    break;
                                case 0o100400: // BMI
                                    //LOG_INSTRUCTION(instruction, 4, "BMI");
                                    if ((CPU.flagN & 0x8000)) {
                                        CPU.registerVal[7] = branch(CPU.registerVal[7], instruction);
                                    }
                                    break;
                                case 0o101400: // BLOS
                                    //LOG_INSTRUCTION(instruction, 4, "BLOS");
                                    if ((CPU.flagC & 0x10000) || !(CPU.flagZ & 0xffff)) {
                                        CPU.registerVal[7] = branch(CPU.registerVal[7], instruction);
                                    }
                                    break;
                                case 0o102000: // BVC
                                    //LOG_INSTRUCTION(instruction, 4, "BVC");
                                    if (!(CPU.flagV & 0x8000)) {
                                        CPU.registerVal[7] = branch(CPU.registerVal[7], instruction);
                                    }
                                    break;
                                case 0o102400: // BVS
                                    //LOG_INSTRUCTION(instruction, 4, "BVS");
                                    if ((CPU.flagV & 0x8000)) {
                                        CPU.registerVal[7] = branch(CPU.registerVal[7], instruction);
                                    }
                                    break;
                                case 0o103000: // BCC
                                    //LOG_INSTRUCTION(instruction, 4, "BCC");
                                    if (!(CPU.flagC & 0x10000)) {
                                        CPU.registerVal[7] = branch(CPU.registerVal[7], instruction);
                                    }
                                    break;
                                case 0o103400: // BCS
                                    //LOG_INSTRUCTION(instruction, 4, "BCS");
                                    if (CPU.flagC & 0x10000) {
                                        CPU.registerVal[7] = branch(CPU.registerVal[7], instruction);
                                    }
                                    break;
                                case 0o104000: // EMT 104000 -> 104377
                                    //LOG_INSTRUCTION(instruction, 7, "EMT");
                                    trap(0o30, 2); // Trap 30 - EMT instruction
                                    break;
                                case 0o104400: // TRAP 104400 -> 104777
                                    //LOG_INSTRUCTION(instruction, 7, "TRAP");
                                    trap(0o34, 4); // Trap 34 - TRAP instruction
                                    break;
                                default:
                                    switch (instruction & 0o177700) { // Single operand instructions xxxxDD
                                        case 0o000100: // JMP 0001DD
                                            //LOG_INSTRUCTION(instruction, 1, "JMP");
                                            if ((virtualAddress = getVirtualByMode(instruction, MMU_WORD)) >= 0) {
                                                CPU.registerVal[7] = virtualAddress & 0xffff;
                                            }
                                            break;
                                        case 0o000300: // SWAB 0003DD
                                            //LOG_INSTRUCTION(instruction, 1, "SWAB");
                                            if ((dst = modifyWordByMode(instruction)) >= 0) {
                                                result = (dst << 8) | (dst >>> 8);
                                                if (modifyWord(result) >= 0) {
                                                    CPU.flagN = CPU.flagZ = dst & 0xff00;
                                                    CPU.flagV = CPU.flagC = 0;
                                                }
                                            }
                                            break;
                                        case 0o005000: // CLR 0050DD
                                            //LOG_INSTRUCTION(instruction, 1, "CLR");
                                            if (writeWordByMode(instruction, 0) >= 0) {
                                                CPU.flagN = CPU.flagC = CPU.flagV = CPU.flagZ = 0;
                                            }
                                            break;
                                        case 0o005100: // COM 0051DD
                                            //LOG_INSTRUCTION(instruction, 1, "COM");
                                            if ((dst = modifyWordByMode(instruction)) >= 0) {
                                                result = ~dst;
                                                if (modifyWord(result) >= 0) {
                                                    CPU.flagN = CPU.flagZ = result;
                                                    CPU.flagC = 0x10000;
                                                    CPU.flagV = 0;
                                                }
                                            }
                                            break;
                                        case 0o005200: // INC 0052DD
                                            //LOG_INSTRUCTION(instruction, 1, "INC");
                                            if ((dst = modifyWordByMode(instruction)) >= 0) {
                                                result = dst + 1;
                                                if (modifyWord(result) >= 0) {
                                                    CPU.flagN = CPU.flagZ = result;
                                                    CPU.flagV = result & (result ^ dst);
                                                }
                                            }
                                            break;
                                        case 0o005300: // DEC 0053DD
                                            //LOG_INSTRUCTION(instruction, 1, "DEC");
                                            if ((dst = modifyWordByMode(instruction)) >= 0) {
                                                result = dst + 0xffff;
                                                if (modifyWord(result) >= 0) {
                                                    CPU.flagN = CPU.flagZ = result;
                                                    CPU.flagV = (result ^ dst) & dst;
                                                }
                                            }

                                            break;
                                        case 0o005400: // NEG 0054DD
                                            //LOG_INSTRUCTION(instruction, 1, "NEG");
                                            if ((dst = modifyWordByMode(instruction)) >= 0) {
                                                result = -dst;
                                                if (modifyWord(result) >= 0) {
                                                    CPU.flagC = CPU.flagN = CPU.flagZ = result;
                                                    CPU.flagV = result & dst;
                                                }
                                            }
                                            break;
                                        case 0o005500: // ADC 0055DD
                                            //LOG_INSTRUCTION(instruction, 1, "ADC");
                                            if ((dst = modifyWordByMode(instruction)) >= 0) {
                                                result = dst + ((CPU.flagC >>> 16) & 1);
                                                if (modifyWord(result) >= 0) {
                                                    CPU.flagC = CPU.flagN = CPU.flagZ = result;
                                                    CPU.flagV = result & (result ^ dst);
                                                }
                                            }
                                            break;
                                        case 0o005600: // SBC 0056DD
                                            //LOG_INSTRUCTION(instruction, 1, "SBC");
                                            if ((dst = modifyWordByMode(instruction)) >= 0) {
                                                result = dst - ((CPU.flagC >>> 16) & 1);
                                                if (modifyWord(result) >= 0) {
                                                    CPU.flagC = CPU.flagN = CPU.flagZ = result;
                                                    CPU.flagV = (result ^ dst) & dst;
                                                }
                                            }
                                            break;
                                        case 0o005700: // TST 0057DD
                                            //LOG_INSTRUCTION(instruction, 1, "TST");
                                            if ((result = readWordByMode(instruction)) >= 0) {
                                                CPU.flagN = CPU.flagZ = result;
                                                CPU.flagC = CPU.flagV = 0;
                                            }
                                            break;
                                        case 0o006000: // ROR 0060DD
                                            //LOG_INSTRUCTION(instruction, 1, "ROR");
                                            if ((dst = modifyWordByMode(instruction)) >= 0) {
                                                result = ((CPU.flagC & 0x10000) | dst) >>> 1;
                                                if (modifyWord(result) >= 0) {
                                                    CPU.flagC = (dst << 16);
                                                    CPU.flagN = CPU.flagZ = result;
                                                    CPU.flagV = result ^ (CPU.flagC >>> 1);
                                                }
                                            }
                                            break;
                                        case 0o006100: // ROL 0061DD
                                            //LOG_INSTRUCTION(instruction, 1, "ROL");
                                            if ((dst = modifyWordByMode(instruction)) >= 0) {
                                                result = (dst << 1) | ((CPU.flagC >>> 16) & 1);
                                                if (modifyWord(result) >= 0) {
                                                    CPU.flagC = CPU.flagN = CPU.flagZ = result;
                                                    CPU.flagV = result ^ dst;
                                                }
                                            }
                                            break;
                                        case 0o006200: // ASR 0062DD
                                            //LOG_INSTRUCTION(instruction, 1, "ASR");
                                            if ((dst = modifyWordByMode(instruction)) >= 0) {
                                                result = (dst & 0x8000) | (dst >>> 1);
                                                if (modifyWord(result) >= 0) {
                                                    CPU.flagC = dst << 16;
                                                    CPU.flagN = CPU.flagZ = result;
                                                    CPU.flagV = CPU.flagN ^ (CPU.flagC >>> 1);
                                                }
                                            }
                                            break;
                                        case 0o006300: // ASL 0063DD
                                            //LOG_INSTRUCTION(instruction, 1, "ASL");
                                            if ((dst = modifyWordByMode(instruction)) >= 0) {
                                                result = dst << 1;
                                                if (modifyWord(result) >= 0) {
                                                    CPU.flagC = CPU.flagN = CPU.flagZ = result;
                                                    CPU.flagV = result ^ dst;
                                                }
                                            }
                                            break;
                                        case 0o006400: // MARK 0064nn
                                            //LOG_INSTRUCTION(instruction, 8, "MARK");
                                            virtualAddress = (CPU.registerVal[7] + ((instruction & 0o77) << 1)) & 0xffff;
                                            if ((result = readWordByVirtual(virtualAddress | 0x10000)) >= 0) {
                                                CPU.registerVal[7] = CPU.registerVal[5];
                                                CPU.registerVal[5] = result;
                                                CPU.registerVal[6] = (virtualAddress + 2) & 0xffff;
                                            }
                                            break;
                                        case 0o006500: // MFPI 0065SS
                                            //LOG_INSTRUCTION(instruction, 1, "MFPI");
                                            if (!(instruction & 0x38)) {
                                                reg = instruction & 7;
                                                if (reg != 6 || ((CPU.PSW >>> 12) & 3) == CPU.mmuMode) {
                                                    src = CPU.registerVal[reg];
                                                } else {
                                                    src = CPU.stackPointer[(CPU.PSW >>> 12) & 3];
                                                }
                                                if (pushWord(src, 0) >= 0) {
                                                    CPU.flagN = CPU.flagZ = src;
                                                    CPU.flagV = 0;
                                                }
                                            } else {
                                                if ((virtualAddress = getVirtualByMode(instruction, MMU_WORD)) >= 0) {
                                                    if ((CPU.PSW & 0xf000) != 0xf000) {
                                                        virtualAddress &= 0xffff;
                                                    }
                                                    CPU.mmuMode = (CPU.PSW >>> 12) & 3; // Use PM
                                                    if ((src = readWordByVirtual(virtualAddress)) >= 0) {
                                                        CPU.mmuMode = (CPU.PSW >>> 14) & 3; // Restore CM
                                                        if (pushWord(src, 0) >= 0) {
                                                            CPU.flagN = CPU.flagZ = src;
                                                            CPU.flagV = 0;
                                                        }
                                                    }
                                                }
                                            }
                                            break;
                                        case 0o006600: // MTPI 0066DD
                                            //LOG_INSTRUCTION(instruction, 1, "MTPI");
                                            if ((result = popWord()) >= 0) {
                                                if (!(CPU.MMR0 & 0xe000)) {
                                                    CPU.MMR1 = 0o26;
                                                }
                                                if (!(instruction & 0x38)) {
                                                    reg = instruction & 7;
                                                    if (reg != 6 || ((CPU.PSW >>> 12) & 3) == CPU.mmuMode) {
                                                        CPU.registerVal[reg] = result;
                                                    } else {
                                                        CPU.stackPointer[(CPU.PSW >>> 12) & 3] = result;
                                                    }
                                                    CPU.flagN = CPU.flagZ = result;
                                                    CPU.flagV = 0;
                                                } else { // Must extract virtual address before mode change...
                                                    if ((virtualAddress = getVirtualByMode(instruction, MMU_WORD)) >= 0) {
                                                        CPU.mmuMode = (CPU.PSW >>> 12) & 3; // Use previous mode
                                                        if (writeWordByVirtual(virtualAddress & 0xffff, result) >= 0) {
                                                            CPU.mmuMode = (CPU.PSW >>> 14) & 3; // Restore CM
                                                            CPU.flagN = CPU.flagZ = result;
                                                            CPU.flagV = 0;
                                                        }
                                                    }
                                                }
                                            }
                                            break;
                                        case 0o006700: // SXT 0067DD
                                            //LOG_INSTRUCTION(instruction, 1, "SXT");
                                            result = ((CPU.flagN & 0x8000) ? 0xffff : 0);
                                            if (writeWordByMode(instruction, result) >= 0) {
                                                CPU.flagZ = result;
                                                CPU.flagV = 0;
                                            }
                                            break;
                                        case 0o105000: // CLRB 1050DD
                                            //LOG_INSTRUCTION(instruction, 1, "CLRB");
                                            if (writeByteByMode(instruction, 0) >= 0) {
                                                CPU.flagN = CPU.flagC = CPU.flagV = CPU.flagZ = 0;
                                            }
                                            break;
                                        case 0o105100: // COMB 1051DD
                                            //LOG_INSTRUCTION(instruction, 1, "COMB");
                                            if ((dst = modifyByteByMode(instruction)) >= 0) {
                                                result = ~dst;
                                                if (modifyByte(result) >= 0) {
                                                    CPU.flagN = CPU.flagZ = result << 8;
                                                    CPU.flagC = 0x10000;
                                                    CPU.flagV = 0;
                                                }
                                            }
                                            break;
                                        case 0o105200: // INCB 1052DD
                                            //LOG_INSTRUCTION(instruction, 1, "INCB");
                                            if ((dst = modifyByteByMode(instruction)) >= 0) {
                                                result = dst + 1;
                                                if (modifyByte(result) >= 0) {
                                                    CPU.flagN = CPU.flagZ = result << 8;
                                                    CPU.flagV = (result & (result ^ dst)) << 8;
                                                }
                                            }
                                            break;
                                        case 0o105300: // DECB 1053DD
                                            //LOG_INSTRUCTION(instruction, 1, "DECB");
                                            if ((dst = modifyByteByMode(instruction)) >= 0) {
                                                result = dst + 0xffff;
                                                if (modifyByte(result) >= 0) {
                                                    CPU.flagN = CPU.flagZ = result << 8;
                                                    CPU.flagV = ((result ^ dst) & dst) << 8;
                                                }
                                            }
                                            break;
                                        case 0o105400: // NEGB 1054DD
                                            //LOG_INSTRUCTION(instruction, 1, "NEGB");
                                            if ((dst = modifyByteByMode(instruction)) >= 0) {
                                                result = -dst;
                                                if (modifyByte(result) >= 0) {
                                                    CPU.flagC = CPU.flagN = CPU.flagZ = result << 8;
                                                    CPU.flagV = (result & dst) << 8;
                                                }
                                            }
                                            break;
                                        case 0o105500: // ADCB 01055DD
                                            //LOG_INSTRUCTION(instruction, 1, "ADCB");
                                            if ((dst = modifyByteByMode(instruction)) >= 0) {
                                                result = dst + ((CPU.flagC >>> 16) & 1);
                                                if (modifyByte(result) >= 0) {
                                                    CPU.flagN = CPU.flagZ = CPU.flagC = result << 8;
                                                    CPU.flagV = (result & (result ^ dst)) << 8;
                                                }
                                            }
                                            break;
                                        case 0o105600: // SBCB 01056DD
                                            //LOG_INSTRUCTION(instruction, 1, "SBCB");
                                            if ((dst = modifyByteByMode(instruction)) >= 0) {
                                                result = dst - ((CPU.flagC >>> 16) & 1);
                                                if (modifyByte(result) >= 0) {
                                                    CPU.flagN = CPU.flagZ = CPU.flagC = result << 8;
                                                    CPU.flagV = ((result ^ dst) & dst) << 8;
                                                }
                                            }
                                            break;
                                        case 0o105700: // TSTB 1057DD
                                            //LOG_INSTRUCTION(instruction, 1, "TSTB");
                                            if ((result = readByteByMode(instruction)) >= 0) {
                                                CPU.flagN = CPU.flagZ = result << 8;
                                                CPU.flagC = CPU.flagV = 0;
                                            }
                                            break;
                                        case 0o106000: // RORB 1060DD
                                            //LOG_INSTRUCTION(instruction, 1, "RORB");
                                            if ((dst = modifyByteByMode(instruction)) >= 0) {
                                                result = (((CPU.flagC & 0x10000) >>> 8) | dst) >>> 1;
                                                if (modifyByte(result) >= 0) {
                                                    CPU.flagC = (dst << 16);
                                                    CPU.flagN = CPU.flagZ = (result << 8);
                                                    CPU.flagV = CPU.flagN ^ (CPU.flagC >>> 1);
                                                }
                                            }
                                            break;
                                        case 0o106100: // ROLB 1061DD
                                            //LOG_INSTRUCTION(instruction, 1, "ROLB");
                                            if ((dst = modifyByteByMode(instruction)) >= 0) {
                                                result = (dst << 1) | ((CPU.flagC >>> 16) & 1);
                                                if (modifyByte(result) >= 0) {
                                                    CPU.flagC = CPU.flagN = CPU.flagZ = result << 8;
                                                    CPU.flagV = (result ^ dst) << 8;
                                                }
                                            }
                                            break;
                                        case 0o106200: // ASRB 1062DD
                                            //LOG_INSTRUCTION(instruction, 1, "ASRB");
                                            if ((dst = modifyByteByMode(instruction)) >= 0) {
                                                result = (dst & 0x80) | (dst >>> 1);
                                                if (modifyByte(result) >= 0) {
                                                    CPU.flagC = dst << 16;
                                                    CPU.flagN = CPU.flagZ = result << 8;
                                                    CPU.flagV = CPU.flagN ^ (CPU.flagC >>> 1);
                                                }
                                            }
                                            break;
                                        case 0o106300: // ASLB 1063DD
                                            //LOG_INSTRUCTION(instruction, 1, "ASLB");
                                            if ((dst = modifyByteByMode(instruction)) >= 0) {
                                                result = dst << 1;
                                                if (modifyByte(result) >= 0) {
                                                    CPU.flagC = CPU.flagN = CPU.flagZ = result << 8;
                                                    CPU.flagV = (result ^ dst) << 8;
                                                }
                                            }
                                            break;
                                            //case 0o106400: // MTPS 1064SS
                                            //    //LOG_INSTRUCTION(instruction, 1, "MTPS");
                                            //    if ((src = readByteByMode(instruction)) >= 0) {
                                            //        writePSW((CPU.PSW & 0xff00) | (src & 0xef));
                                            //    } // Temporary PDP 11/34A
                                            //    break;
                                        case 0o106500: // MFPD 1065DD
                                            //LOG_INSTRUCTION(instruction, 1, "MFPD");
                                            if (!(instruction & 0x38)) {
                                                reg = instruction & 7;
                                                if (reg != 6 || ((CPU.PSW >>> 12) & 3) == CPU.mmuMode) {
                                                    src = CPU.registerVal[reg];
                                                } else {
                                                    src = CPU.stackPointer[(CPU.PSW >>> 12) & 3];
                                                }
                                                if (pushWord(src, 0) >= 0) {
                                                    CPU.flagN = CPU.flagZ = src;
                                                    CPU.flagV = 0;
                                                }
                                            } else {
                                                if ((virtualAddress = getVirtualByMode(instruction, MMU_WORD)) >= 0) {
                                                    CPU.mmuMode = (CPU.PSW >>> 12) & 3; // Use PM
                                                    if ((src = readWordByVirtual(virtualAddress | 0x10000)) >= 0) {
                                                        CPU.mmuMode = (CPU.PSW >>> 14) & 3; // Restore CM
                                                        if (pushWord(src, 0) >= 0) {
                                                            CPU.flagN = CPU.flagZ = src;
                                                            CPU.flagV = 0;
                                                        }
                                                    }
                                                }
                                            }
                                            break;
                                        case 0o106600: // MTPD 1066DD
                                            //LOG_INSTRUCTION(instruction, 1, "MTPD");
                                            if ((result = popWord()) >= 0) {
                                                if (!(CPU.MMR0 & 0xe000)) {
                                                    CPU.MMR1 = 0o26;
                                                }
                                                if (!(instruction & 0x38)) {
                                                    reg = instruction & 7;
                                                    if (reg != 6 || ((CPU.PSW >>> 12) & 3) == CPU.mmuMode) {
                                                        CPU.registerVal[reg] = result;
                                                    } else {
                                                        CPU.stackPointer[(CPU.PSW >>> 12) & 3] = result;
                                                    }
                                                    CPU.flagN = CPU.flagZ = result;
                                                    CPU.flagV = 0;
                                                } else { // Must extract virtual address before mode change...
                                                    if ((virtualAddress = getVirtualByMode(instruction, MMU_WORD)) >= 0) {
                                                        CPU.mmuMode = (CPU.PSW >>> 12) & 3; // Use PM
                                                        if (writeWordByVirtual(virtualAddress | 0x10000, result) >= 0) {
                                                            CPU.mmuMode = (CPU.PSW >>> 14) & 3; // Restore CM
                                                            CPU.flagN = CPU.flagZ = result;
                                                            CPU.flagV = 0;
                                                        }
                                                    }
                                                }
                                            }
                                            break;
                                            //case 0o106700: // MTFS 1064SS
                                            //    //LOG_INSTRUCTION(instruction, 1, "MFPS");
                                            //    result = readPSW() & 0xff;
                                            //    if (!(instruction & 0x38)) {
                                            //        if (result & 0o200) {
                                            //            result |= 0xff00;
                                            //        }
                                            //        CPU.registerVal[instruction & 7] = result;
                                            //        CPU.flagN = CPU.flagZ = result << 8;
                                            //        CPU.flagV = 0;
                                            //    } else {
                                            //        if (writeByteByMode(instruction, result) >= 0) {
                                            //            CPU.flagN = CPU.flagZ = result << 8;
                                            //            CPU.flagV = 0;
                                            //        }
                                            //    } // Temporary PDP 11/34A
                                            //    break;
                                        default:
                                            switch (instruction & 0o177770) { // Single register instructions xxxxxR (and CC)
                                                case 0o000200: // RTS 00020R
                                                    //LOG_INSTRUCTION(instruction, 6, "RTS");
                                                    if ((result = popWord()) >= 0) {
                                                        reg = instruction & 7;
                                                        CPU.registerVal[7] = CPU.registerVal[reg];
                                                        CPU.registerVal[reg] = result;
                                                    }
                                                    break;
                                                case 0o000230: // SPL 00023N
                                                    //LOG_INSTRUCTION(instruction, 9, "SPL");
                                                    if (!CPU.mmuMode) {
                                                        CPU.PSW = (CPU.PSW & 0xf81f) | ((instruction & 7) << 5);
                                                        CPU.priorityReview = 2;
                                                    }
                                                    break;
                                                case 0o000240: // CLR CC 00024M Part 1 without N
                                                case 0o000250: // CLR CC 00025M Part 2 with N
                                                    //LOG_INSTRUCTION(instruction, 10, "CLR CC");
                                                    if (instruction & 1) {
                                                        CPU.flagC = 0; // CLC
                                                    }
                                                    if (instruction & 2) {
                                                        CPU.flagV = 0; // CLV
                                                    }
                                                    if (instruction & 4) {
                                                        CPU.flagZ = 1; // CLZ
                                                    }
                                                    if (instruction & 8) {
                                                        CPU.flagN = 0; // CLN
                                                    }
                                                    break;
                                                case 0o000260: // SET CC 00026M Part 1 without N
                                                case 0o000270: // SET CC 00026M Part 2 with N
                                                    //LOG_INSTRUCTION(instruction, 10, "SET CC");
                                                    if (instruction & 1) {
                                                        CPU.flagC = 0x10000; // SEC
                                                    }
                                                    if (instruction & 2) {
                                                        CPU.flagV = 0x8000; // SEV
                                                    }
                                                    if (instruction & 4) {
                                                        CPU.flagZ = 0; // SEZ
                                                    }
                                                    if (instruction & 8) {
                                                        CPU.flagN = 0x8000; // SEN
                                                    }
                                                    break;
                                                default: // Misc instructions (decode ALL remaining bits) xxxxxx
                                                    switch (instruction) {
                                                        case 0o000000: // HALT 000000
                                                            //LOG_INSTRUCTION(instruction, 0, "HALT");
                                                            if (0xc000 & CPU.PSW) {
                                                                CPU.CPU_Error |= 0o200;
                                                                trap(4, 46);
                                                            } else {
                                                                CPU.runState = STATE_HALT; // halt
                                                                loopCount = 0; // go update the lights
                                                                console.log("HALT at " + CPU.registerVal[7].toString(8) + " PSW: " + readPSW().toString(8));
                                                            }
                                                            break;
                                                        case 0o000001: // WAIT 000001
                                                            //LOG_INSTRUCTION(instruction, 0, "WAIT");
                                                            if (!interruptWaitRelease()) {
                                                                CPU.runState = STATE_WAIT; // WAIT; // Go to wait state and exit loop
                                                                loopCount = 0; // go update the lights
                                                            }
                                                            break;
                                                        case 0o000003: // BPT  000003
                                                            //LOG_INSTRUCTION(instruction, 0, "BPT");
                                                            trap(0o14, 6); // Trap 14 - BPT
                                                            break;
                                                        case 0o000004: // IOT  000004
                                                            //LOG_INSTRUCTION(instruction, 0, "IOT");
                                                            trap(0o20, 8); // Trap 20 - IOT
                                                            break;
                                                        case 0o000005: // RESET 000005
                                                            //LOG_INSTRUCTION(instruction, 0, "RESET");
                                                            if (!CPU.mmuMode) {
                                                                reset_iopage();
                                                                CPU.runState = STATE_RESET; // reset state for special pause
                                                                loopCount = 0; // go update the lights
                                                            }
                                                            break;
                                                        case 0o000002: // RTI 000002
                                                        case 0o000006: // RTT 000006
                                                            //LOG_INSTRUCTION(instruction, 0, "RTT");
                                                            if ((result = popWord()) >= 0) { // new PC
                                                                if ((savePSW = popWord()) >= 0) { // new PSW
                                                                    savePSW &= 0xf8ff;
                                                                    if (CPU.mmuMode) { // user / super restrictions
                                                                        // keep SPL and allow lower only for modes and register set
                                                                        savePSW = (savePSW & 0xf81f) | (CPU.PSW & 0xf8e0);
                                                                    }
                                                                    CPU.registerVal[7] = result;
                                                                    writePSW(savePSW);
                                                                    CPU.trapMask &= ~0x10; // turn off Trace trap
                                                                    if (instruction == 2) {
                                                                        CPU.trapMask |= CPU.PSW & 0x10; // RTI enables immediate trace
                                                                    }
                                                                }
                                                            }
                                                            break;
                                                            //case 0o000007: // MFPT 000007
                                                            //    //LOG_INSTRUCTION(instruction, 0, "MFPT");
                                                            //    CPU.registerVal[0] = 1;
                                                            //    break; // Exists on pdp 11/44 & KB11-EM
                                                        default: // We don't know this instruction
                                                            //LOG_INSTRUCTION(instruction, 11, "-unknown-");
                                                            trap(0o10, 48); // Trap 10 - Illegal instruction
                                                            break;
                                                    }
                                            }
                                    }
                            }
                    }
            }
        }

        if (--loopCount <= 0) { // When loopCount reaches zero do timer/exit checks
            if (Date.now() >= loopTime || loopCount < 0) {
                break;
            }
            loopCount = 1000;
        }
    } while (1);

    if (CPU.runState == STATE_RUN) {
        CPU.displayDataPaths = result & 0xffff;
        setTimeout(emulate, 0, 1000); // immediately schedule another batch of instructions
    } else {
        CPU.displayDataPaths = CPU.registerVal[0];
        CPU.displayAddress = CPU.registerVal[7];
        if (CPU.runState == STATE_RESET) {
            CPU.runState = STATE_RUN;
            setTimeout(emulate, 60, 1000); // schedule instructions after a reset pause
        }
    }
}


var panel = {
    addressLights: 0x3fffff, // current state of addressLights (a0-a21)
    displayLights: 0xffff, // current state of displayLights (d0-d15)
    statusLights: 0x3ffffff, // current state of statusLights (s0-s25)
    addressId: [], // DOM id's for addressLighrs
    displayId: [], // DOM id's for displayLighrs
    statusId: [], // DOM id's for statusLighrs
    LIGHTS_STATE: [0x280, 0x300, 0x100, 0x80], // RUN, RESET, WAIT, HALT -> RUN, MASTER, PAUSE lights
    LIGHTS_MODE: [0x10, 0x20, 0, 0x40], // Kernel, Super, Undefined, User -> Kernel, Super, User lights
    rotary1: 0,
    rotary0: 0,
    powerSwitch: 0, // -1 off, 0 run, 1 locked
    halt: 0,
    step: 0,
    lampTest: 0,
    autoIncr: 0
};

function initPanel(idName, idCount) {
    "use strict";
    var id, idArray = [];
    for (id = 0; id < idCount; id++) {
        idArray[id] = document.getElementById(idName + id);
    }
    return idArray;
}

// There are three groups of lights (LEDs/Globes):-
//  addressLights (a0-a21) which show either a virtual or physical memory address depending on switch rotary0
//  displayLights (d0-d15) shows current data depending on switch rotary1
//  statusLights (s0-s25) all else from MMU status, CPU mode, Bus status, parity, and position of rotary switches
// The updateLights() function runs frequently to calculate the three light bit mask values and then set the appropriate
// light visibility to either hidden or visible.
//
// statusLights:         25 24 23 22 21 20 19 18 17 16 15 14 13 12 11 10  9  8  7  6  5  4  3  2  1  0
//                      |  rotary1  |       rotary0         | PAR |PE AE Rn Pa Ma Us Su Ke Da 16 18 22

function updateLights() {
    "use strict";
    var addressLights, displayLights, statusLights;

    function updatePanel(oldMask, newMask, idArray) {
        var id = 0,
            mask = oldMask ^ newMask;
        while (mask) {
            while (!(mask & 1)) {
                mask >>= 1;
                id++;
            }
            if (idArray[id]) {
                idArray[id].style.visibility = ((newMask & (1 << id)) ? 'visible' : 'hidden'); // or display = "none"
            }
            mask >>= 1;
            id++;
        }
    }
    if (panel.powerSwitch < 0) {
        addressLights = 0;
        displayLights = 0;
        statusLights = 0;
    } else {
        if (panel.lampTest) {
            addressLights = 0x3fffff;
            displayLights = 0xffff;
            statusLights = 0x3ffffff;
        } else {
            if (panel.rotary0 != 1) {
                addressLights = CPU.displayAddress;
            } else {
                addressLights = CPU.displayPhysical;
            }
            switch (panel.rotary1) {
                case 0:
                case 1:
                    displayLights = CPU.displayDataPaths;
                    break;
                case 2:
                    displayLights = CPU.switchRegister;
                    break;
                case 3:
                    displayLights = CPU.displayRegister;
                    break;
            }
            statusLights = (0x400000 << panel.rotary1) | (0x4000 << panel.rotary0) | // switch lights
                0x3000 | CPU.statusLights | // Parity (always on), address error and data lights
                panel.LIGHTS_STATE[CPU.runState] | panel.LIGHTS_MODE[CPU.mmuMode] | // State and mode lights
                ((CPU.mmuEnable) ? (CPU.MMR3 & 0x10) ? 1 : 2 : 4); // MMU status (16, 18, 22)
        }
    }
    if (addressLights != panel.addressLights) {
        updatePanel(panel.addressLights, addressLights, panel.addressId);
        panel.addressLights = addressLights;
    }
    if (displayLights != panel.displayLights) {
        updatePanel(panel.displayLights, displayLights, panel.displayId);
        panel.displayLights = displayLights;
    }
    if (statusLights != panel.statusLights) {
        updatePanel(panel.statusLights, statusLights, panel.statusId);
        panel.statusLights = statusLights;
    }
    requestAnimationFrame(updateLights);
}

// One off functions to find light objects and to start animations

panel.addressId = initPanel("a", 22);
panel.displayId = initPanel("d", 16);
panel.statusId = initPanel("s", 26);
requestAnimationFrame(updateLights);

function boot() { // Reset processor, copy bootcode into memory, jump to start of bootcode
    "use strict";
    var i;
    for (i = 0; i < IOBASE_UNIBUS / 2; i++) {
        CPU.memory[i] = 0;
    }
    for (i = 0; i < bootcode.length; i++) {
        CPU.memory[(BOOTBASE >>> 1) + i] = bootcode[i];
    }
    CPU.registerVal[7] = CPU.registerVal[6] = BOOTBASE;
    CPU.PIR = 0;
    writePSW(0);
    reset_iopage();
    if (CPU.runState != STATE_RUN) {
        CPU.runState = STATE_RUN;
        emulate(1000);
    }
}